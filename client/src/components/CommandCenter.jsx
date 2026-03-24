// client/src/components/CommandCenter.jsx
// ── PNTHR Command Center — Portfolio Management Dashboard ─────────────────────
//
// Tier A pyramiding: 15-30-25-20-10 · Editable fills, stops, prices
// Live position data from /api/positions + kill signals from /api/kill-pipeline
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from 'react';
import { API_BASE, authHeaders, updateUserProfile, fetchNav, fetchPendingEntries, confirmPendingEntry, dismissPendingEntry, deletePosition } from '../services/api.js';
import { useAuth } from '../AuthContext';
import { STRIKE_PCT, LOT_NAMES, LOT_OFFSETS, LOT_TIME_GATES, buildLots, enrichLots, sizePosition, calcHeat, isEtfTicker } from '../utils/sizingUtils.js';
import ChartModal from './ChartModal';

// (buildLots, enrichLots, sizePosition, calcHeat imported from ../utils/sizingUtils.js)

// ── Risk Advisor Helpers ──────────────────────────────────────────────────────

// ── Manual price override helper ──────────────────────────────────────────────
// Returns the price to use for display and lot-trigger calculations.
// If a manualPriceOverride is active AND the live market price hasn't yet
// reached the override level, the override price is used.
// Once the market catches up (or the override is cleared), live price resumes.
function getDisplayPrice(p) {
  const ov = p.manualPriceOverride;
  if (!ov?.active) return p.currentPrice ?? 0;
  return ov.price; // always use override while active; cleared by ✕ or when FMP catches up
}

function highestFilledLot(p) {
  let high = 0;
  for (let i = 1; i <= 5; i++) if (p.fills?.[i]?.filled) high = i;
  return high;
}

function filledSharesOf(p) {
  let total = 0;
  for (let i = 1; i <= 5; i++) {
    const f = p.fills?.[i];
    if (f?.filled) total += +(f.shares ?? 0);
  }
  return total;
}

function avgCostOf(p) {
  let cost = 0, shares = 0;
  for (let i = 1; i <= 5; i++) {
    const f = p.fills?.[i];
    if (f?.filled && f?.price && f?.shares) { cost += +f.shares * +f.price; shares += +f.shares; }
  }
  return shares > 0 ? cost / shares : (p.entryPrice || 0);
}

function pnlPctOf(p) {
  const avg = avgCostOf(p);
  if (!avg || !p.currentPrice) return 0;
  const raw = (p.currentPrice - avg) / avg * 100;
  return p.direction === 'SHORT' ? -raw : raw;
}

function isRecycledPos(p) {
  const avg = avgCostOf(p);
  return p.direction === 'LONG' ? p.stopPrice >= avg : p.stopPrice <= avg;
}

function runRiskAdvisor(positions, nav) {
  const recs = [];
  if (!positions.length || !nav) return recs;

  const livePos = positions.filter(p => !isRecycledPos(p));
  const liveCnt = livePos.length;

  // Rule 1: Heat Cap Violation — actual dollar risk vs caps (stocks 10%, ETFs 5%, total 15%)
  const heat = calcHeat(positions, nav);
  if (heat.stockRiskPct > 10) {
    const excess = +(heat.stockRisk - nav * 0.10).toFixed(0);
    const candidates = [...livePos].filter(p => !p.isETF).sort((a, b) => pnlPctOf(a) - pnlPctOf(b)).slice(0, 2);
    recs.push({
      priority: 'CRITICAL', type: 'HEAT_VIOLATION',
      message: `Stock risk at ${heat.stockRiskPct}% — exceeds 10% cap. Reduce by $${excess}.`,
      actions: candidates.map(p => ({ ticker: p.ticker, action: 'CLOSE', shares: filledSharesOf(p), reason: `Worst performer at ${pnlPctOf(p).toFixed(1)}%` })),
    });
  }
  if (heat.etfRiskPct > 5) {
    const excess = +(heat.etfRisk - nav * 0.05).toFixed(0);
    recs.push({
      priority: 'CRITICAL', type: 'ETF_HEAT_VIOLATION',
      message: `ETF risk at ${heat.etfRiskPct}% — exceeds 5% cap. Reduce by $${excess}.`,
      actions: livePos.filter(p => p.isETF).sort((a, b) => pnlPctOf(a) - pnlPctOf(b)).slice(0, 1)
        .map(p => ({ ticker: p.ticker, action: 'TRIM', shares: filledSharesOf(p), reason: 'ETF risk cap exceeded' })),
    });
  }
  if (heat.totalRiskPct > 15) {
    recs.push({
      priority: 'CRITICAL', type: 'TOTAL_HEAT_VIOLATION',
      message: `Combined risk at ${heat.totalRiskPct}% — exceeds 15% total cap.`,
      actions: [],
    });
  }

  // Rule 2: Sector Concentration (>3 per sector) — ETFs exempt (they ARE the diversification)
  const bySector = {};
  for (const p of livePos) {
    if (p.isETF || isEtfTicker(p.ticker)) continue; // ETFs tracked by dollar risk cap, not sector count
    const s = p.sector || 'Unknown';
    (bySector[s] = bySector[s] || []).push(p);
  }
  for (const [sector, sPos] of Object.entries(bySector)) {
    if (sPos.length > 3) {
      const excess = sPos.length - 3;
      const weakest = [...sPos].sort((a, b) => pnlPctOf(a) - pnlPctOf(b)).slice(0, excess);
      recs.push({
        priority: 'HIGH', type: 'SECTOR_CONCENTRATION',
        message: `${sector}: ${sPos.length} positions (max 3). ${excess} must close.`,
        actions: weakest.map(p => ({ ticker: p.ticker, action: 'CLOSE', shares: filledSharesOf(p), reason: `Weakest in ${sector} at ${pnlPctOf(p).toFixed(1)}%` })),
      });
    }
  }

  // Rule 3: Stale Hunt Alert (Lot 1 only, ≥15 trading days)
  for (const p of positions) {
    if (highestFilledLot(p) <= 1 && (p.tradingDaysActive ?? 0) >= 15) {
      const d = p.tradingDaysActive;
      recs.push({
        priority: d >= 20 ? 'CRITICAL' : 'HIGH', type: 'STALE_HUNT',
        message: `${p.ticker}: Day ${d}/20 at Lot 1. ${d >= 20 ? 'LIQUIDATE NOW.' : `${20 - d} trading day${20 - d !== 1 ? 's' : ''} remaining.`}`,
        actions: [{ ticker: p.ticker, action: d >= 20 ? 'LIQUIDATE' : 'MONITOR', shares: filledSharesOf(p), reason: 'Stale Hunt Rule' }],
      });
    }
  }

  // Rule 4: Lot 2 Ready (at Lot 1, ≥5 days, price gate met)
  for (const p of positions) {
    if (highestFilledLot(p) === 1 && (p.tradingDaysActive ?? 0) >= 5) {
      const lot1Price = p.fills?.[1]?.price;
      if (!lot1Price) continue;
      const trigger = p.direction === 'LONG' ? +(lot1Price * 1.03).toFixed(2) : +(lot1Price * 0.97).toFixed(2);
      const priceReady = p.direction === 'LONG' ? getDisplayPrice(p) >= trigger : getDisplayPrice(p) <= trigger;
      if (priceReady) {
        const sizing = sizePosition({ netLiquidity: nav, entryPrice: p.entryPrice, stopPrice: p.stopPrice, maxGapPct: p.maxGapPct || 0, direction: p.direction });
        const lot2Shares = Math.round(sizing.totalShares * 0.30);
        recs.push({
          priority: 'ACTION', type: 'LOT2_READY',
          message: `${p.ticker}: Lot 2 (The Stalk) is READY. Price and time gate both confirmed.`,
          actions: [{ ticker: p.ticker, action: 'BUY', shares: lot2Shares, price: trigger, reason: 'Scale in 30% — Lot 2 trigger met' }],
        });
      }
    }
  }

  // Rule 5: Stop Ratchet Needed (Lot 3+ filled, stop not at breakeven)
  for (const p of positions) {
    const highLot = highestFilledLot(p);
    const lot1Fill = p.fills?.[1]?.price;
    if (highLot >= 3 && lot1Fill) {
      const needsRatchet = p.direction === 'LONG' ? p.stopPrice < +lot1Fill : p.stopPrice > +lot1Fill;
      if (needsRatchet) {
        const newStop = +(+lot1Fill).toFixed(2);
        recs.push({
          priority: 'HIGH', type: 'RATCHET_NEEDED',
          message: `${p.ticker}: At Lot ${highLot} but stop ($${p.stopPrice}) is ${p.direction === 'LONG' ? 'below' : 'above'} breakeven ($${newStop}). MOVE STOP.`,
          actions: [{ ticker: p.ticker, action: 'MOVE_STOP', newStop, oldStop: p.stopPrice, reason: 'Breakeven ratchet overdue' }],
        });
      }
    }
  }

  // Rule 6: FEAST Alert (RSI > 85)
  for (const p of positions) {
    if (p.feastAlert || (p.feastRSI && p.feastRSI > 85)) {
      const rsi = p.feastRSI;
      const sellShares = Math.floor(filledSharesOf(p) / 2);
      recs.push({
        priority: 'CRITICAL', type: 'FEAST',
        message: `${p.ticker}: Weekly RSI at ${rsi ? rsi.toFixed(0) : '85+'}. FEAST RULE — sell 50% immediately.`,
        actions: [{ ticker: p.ticker, action: 'SELL', shares: sellShares, reason: `RSI ${rsi ? rsi.toFixed(0) : '85+'} > 85 — lock in parabolic gains` }],
      });
    }
  }

  // Rule 7: Position Oversized (>10% ticker cap)
  for (const p of positions) {
    const shares = filledSharesOf(p);
    if (!shares || !p.currentPrice) continue;
    const posValue = shares * p.currentPrice;
    const tickerCap = nav * 0.10;
    if (posValue > tickerCap) {
      const sharesToSell = Math.ceil((posValue - tickerCap) / p.currentPrice);
      recs.push({
        priority: 'HIGH', type: 'OVERSIZED',
        message: `${p.ticker}: Position value $${posValue.toFixed(0)} exceeds 10% cap ($${tickerCap.toFixed(0)}).`,
        actions: [{ ticker: p.ticker, action: 'TRIM', shares: sharesToSell, reason: `Reduce by ${sharesToSell} shares to meet ticker cap` }],
      });
    }
  }

  // Rule 8: Dollar Risk Exceeds Vitality (1% stocks, 0.5% ETFs)
  for (const p of positions) {
    if (isRecycledPos(p)) continue;
    const shares = filledSharesOf(p);
    if (!shares) continue;
    const riskPerShare = Math.abs(avgCostOf(p) - p.stopPrice);
    if (!riskPerShare) continue;
    const posRisk  = shares * riskPerShare;
    const isEtf    = p.isETF || isEtfTicker(p.ticker);
    const vitality = nav * (isEtf ? 0.005 : 0.01);
    const vPct     = isEtf ? '0.5%' : '1%';
    if (posRisk > vitality * 1.1) {
      const maxShares    = Math.floor(vitality / riskPerShare);
      const excessShares = shares - maxShares;
      recs.push({
        priority: 'HIGH', type: 'RISK_EXCEEDED',
        message: `${p.ticker}: $${posRisk.toFixed(0)} at risk exceeds ${vPct} Vitality ($${vitality.toFixed(0)})${isEtf ? ' (ETF tier)' : ''}.`,
        actions: [{ ticker: p.ticker, action: 'TRIM', shares: excessShares, reason: `Sell ${excessShares} shares to bring risk within ${vPct}` }],
      });
    }
  }

  // Sort: CRITICAL → HIGH → ACTION
  const ORDER = { CRITICAL: 0, HIGH: 1, ACTION: 2 };
  recs.sort((a, b) => (ORDER[a.priority] ?? 9) - (ORDER[b.priority] ?? 9));
  return recs;
}

function formatAction(a) {
  switch (a.action) {
    case 'CLOSE':      return `CLOSE ${a.ticker}${a.shares ? ` (${a.shares} shares at market)` : ''} — ${a.reason}`;
    case 'LIQUIDATE':  return `LIQUIDATE ${a.ticker}${a.shares ? ` (${a.shares} shares at market)` : ''} — ${a.reason}`;
    case 'BUY':        return `BUY ${a.shares} shares of ${a.ticker}${a.price ? ` at $${a.price}` : ''} — ${a.reason}`;
    case 'SELL':       return `SELL ${a.shares} shares of ${a.ticker} — ${a.reason}`;
    case 'TRIM':       return `TRIM ${a.ticker} — sell ${a.shares} shares — ${a.reason}`;
    case 'MOVE_STOP':  return `MOVE ${a.ticker} stop from $${a.oldStop} → $${a.newStop} — ${a.reason}`;
    case 'MONITOR':    return `MONITOR ${a.ticker} — ${a.reason}`;
    default:           return `${a.action} ${a.ticker} — ${a.reason}`;
  }
}

const PRIORITY_STYLE = {
  CRITICAL: { bg: 'rgba(220,53,69,0.12)',  border: 'rgba(220,53,69,0.35)',  badge: '#dc3545', text: '#ff6b6b' },
  HIGH:     { bg: 'rgba(255,193,7,0.08)',  border: 'rgba(255,193,7,0.3)',   badge: '#ffc107', text: '#FFD700' },
  ACTION:   { bg: 'rgba(40,167,69,0.08)', border: 'rgba(40,167,69,0.3)',  badge: '#28a745', text: '#4ade80' },
};

function RiskAdvisor({ recommendations }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('pnthr_advisor_open') !== 'false'; } catch { return true; }
  });

  const toggle = () => setOpen(v => {
    const next = !v;
    try { localStorage.setItem('pnthr_advisor_open', String(next)); } catch {}
    return next;
  });

  const critCount = recommendations.filter(r => r.priority === 'CRITICAL').length;
  const highCount = recommendations.filter(r => r.priority === 'HIGH').length;
  const actCount  = recommendations.filter(r => r.priority === 'ACTION').length;
  const allClear  = recommendations.length === 0;
  const headerColor = allClear ? '#28a745' : critCount > 0 ? '#dc3545' : highCount > 0 ? '#ffc107' : '#28a745';

  return (
    <div style={{ marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: `1px solid ${headerColor}40` }}>
      <div onClick={toggle} style={{ background: `${headerColor}18`, padding: '9px 16px', cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: headerColor, letterSpacing: '0.1em' }}>⚡ RISK ADVISOR</span>
          {allClear ? (
            <span style={{ fontSize: 11, color: '#28a745' }}>— All Clear · Portfolio healthy</span>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              {critCount > 0 && <span style={{ fontSize: 10, background: 'rgba(220,53,69,0.2)', color: '#dc3545', padding: '2px 7px', borderRadius: 4, fontWeight: 700 }}>{critCount} CRITICAL</span>}
              {highCount > 0 && <span style={{ fontSize: 10, background: 'rgba(255,193,7,0.15)', color: '#ffc107', padding: '2px 7px', borderRadius: 4, fontWeight: 700 }}>{highCount} HIGH</span>}
              {actCount  > 0 && <span style={{ fontSize: 10, background: 'rgba(40,167,69,0.15)', color: '#28a745', padding: '2px 7px', borderRadius: 4, fontWeight: 700 }}>{actCount} ACTION</span>}
            </div>
          )}
        </div>
        <span style={{ color: '#555', fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && !allClear && (
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(0,0,0,0.2)' }}>
          {recommendations.map((rec, i) => {
            const s = PRIORITY_STYLE[rec.priority] || PRIORITY_STYLE.HIGH;
            return (
              <div key={i} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, background: s.badge, color: '#000', padding: '2px 6px', borderRadius: 3, letterSpacing: '0.08em' }}>
                    {rec.priority}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#e8e6e3' }}>{rec.message}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {rec.actions.map((a, j) => (
                    <div key={j} style={{ fontSize: 11, color: s.text, fontFamily: 'monospace',
                      paddingLeft: 8, borderLeft: `2px solid ${s.border}` }}>
                      → {formatAction(a)}
                    </div>
                  ))}
                  {rec.alternative && (
                    <div style={{ fontSize: 11, color: '#666', marginTop: 4, fontStyle: 'italic' }}>
                      Alt: {rec.alternative}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Tiny UI Components ────────────────────────────────────────────────────────

function Badge({ children, color = '#888', bg, small }) {
  return (
    <span style={{ display: 'inline-block', padding: small ? '1px 6px' : '2px 8px', borderRadius: 4,
      fontSize: small ? 10 : 11, fontWeight: 600, color, background: bg || 'rgba(255,255,255,0.06)',
      textTransform: 'uppercase', whiteSpace: 'nowrap', lineHeight: '18px', letterSpacing: '0.02em' }}>
      {children}
    </span>
  );
}
function SigBadge({ d }) {
  return d === 'LONG'
    ? <Badge color="#0f5132" bg="#d1e7dd">LONG</Badge>
    : <Badge color="#842029" bg="#f8d7da">SHORT</Badge>;
}
function TierBadge({ t }) {
  const map = { 'ALPHA PNTHR KILL': '#FFD700', 'STRIKING': '#FF8C00', 'HUNTING': '#4A90D9', 'POUNCING': '#5B8C5A' };
  const bg  = map[t] || '#555';
  return <Badge color={['ALPHA PNTHR KILL','STRIKING'].includes(t) ? '#000' : '#fff'} bg={bg}>{t}</Badge>;
}
function MC({ label, value, sub, sub2, accent }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '12px 14px',
      border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 10, color: '#777', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || '#e8e6e3', marginTop: 2, fontFamily: 'monospace' }}>{value}</div>
      {sub  && <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>{sub}</div>}
      {sub2 && <div style={{ fontSize: 10, color: '#888', marginTop: 1 }}>{sub2}</div>}
    </div>
  );
}
const fI = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4, padding: '4px 6px', color: '#FFD700', fontSize: 12,
  fontFamily: 'monospace', outline: 'none', textAlign: 'right',
};

// ── API Helpers ───────────────────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(`${API_BASE || ''}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE || ''}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ── Exit Panel ────────────────────────────────────────────────────────────────

function ExitPanel({ position, onClose, onConfirm }) {
  const totalFilled = (() => {
    let s = 0;
    for (let i = 1; i <= 5; i++) { const f = position.fills?.[i]; if (f?.filled) s += +(f.shares ?? 0); }
    return s;
  })();
  const remaining = position.remainingShares != null ? position.remainingShares : totalFilled;

  // avg cost for impact preview
  const avgCost = (() => {
    let cost = 0, sh = 0;
    for (let i = 1; i <= 5; i++) { const f = position.fills?.[i]; if (f?.filled && f.price) { cost += f.price * +(f.shares ?? 0); sh += +(f.shares ?? 0); } }
    return sh > 0 ? cost / sh : (position.entryPrice || 0);
  })();

  const nowTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  const [shares,     setShares]     = useState('');
  const [price,      setPrice]      = useState(position.currentPrice ? position.currentPrice.toFixed(2) : '');
  const [date,       setDate]       = useState(new Date().toISOString().split('T')[0]);
  const [time,       setTime]       = useState(nowTime);
  const [reason,     setReason]     = useState('SIGNAL');
  const [note,       setNote]       = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err,        setErr]        = useState('');

  const REASONS = [
    { value: 'SIGNAL',     label: 'SIGNAL — PNTHR exit signal (BE/SE) fired' },
    { value: 'FEAST',      label: 'FEAST — RSI extreme, selling per FEAST rule' },
    { value: 'STOP_HIT',   label: 'STOP_HIT — Stop price was hit' },
    { value: 'STALE_HUNT', label: 'STALE_HUNT — 20-day timer expired' },
    { value: 'MANUAL',     label: 'MANUAL — Discretionary override ⚠' },
  ];

  const sharesNum   = parseFloat(shares) || 0;
  const priceNum    = parseFloat(price)  || 0;
  const isManual    = reason === 'MANUAL';
  const canSubmit   = sharesNum > 0 && sharesNum <= remaining && priceNum > 0 && date && (!isManual || note.trim());

  // Impact preview
  const diff        = position.direction === 'SHORT' ? avgCost - priceNum : priceNum - avgCost;
  const pnlDollar   = diff * sharesNum;
  const pnlPct      = avgCost > 0 ? diff / avgCost * 100 : 0;
  const afterRemain = remaining - sharesNum;

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    if (!sharesNum || sharesNum <= 0) return setErr('Shares must be > 0');
    if (!priceNum  || priceNum  <= 0) return setErr('Price must be > 0');
    if (sharesNum > remaining)        return setErr(`Max ${remaining} shares remaining`);
    if (isManual && !note.trim())     return setErr('Note required for manual exits');
    setSubmitting(true);
    try {
      await onConfirm({ shares: sharesNum, price: priceNum, date, time, reason, note: note.trim() || undefined });
    } catch (ex) {
      setErr(ex.message || 'Exit failed');
    } finally {
      setSubmitting(false);
    }
  }

  const labelSt = { color: '#888', fontSize: 11, marginBottom: 2 };
  const inputSt = { background: '#111', border: '1px solid #333', color: '#fff', borderRadius: 4, padding: '4px 8px', fontSize: 12, width: '100%', boxSizing: 'border-box' };
  const colSt   = { display: 'flex', flexDirection: 'column', gap: 2 };

  return (
    <form onSubmit={handleSubmit} style={{ background: '#0d0d0d', border: '1px solid #FFD700', borderRadius: 8, padding: '12px 14px', marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ color: '#FFD700', fontWeight: 700, fontSize: 12, letterSpacing: 1 }}>
          EXIT SHARES — {position.ticker}
          <span style={{ color: '#555', fontWeight: 400, marginLeft: 8 }}>{remaining} remaining · avg ${avgCost.toFixed(2)}</span>
        </span>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>

      {/* Shares + quick % buttons */}
      <div style={{ ...colSt, marginBottom: 8 }}>
        <label style={labelSt}>SHARES TO EXIT</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input style={{ ...inputSt, width: 90 }} type="number" min="1" step="1" value={shares} onChange={e => setShares(e.target.value)} placeholder="0" required />
          <span style={{ color: '#444', fontSize: 11 }}>of {remaining}</span>
          {[25, 50, 75, 100].map(pct => (
            <button key={pct} type="button"
              onClick={() => setShares(String(Math.floor(remaining * pct / 100) || 1))}
              style={{ background: '#1a1a1a', border: '1px solid #444', color: '#FFD700', borderRadius: 4, padding: '3px 8px', fontSize: 10, cursor: 'pointer', fontWeight: 700 }}>
              {pct}%
            </button>
          ))}
        </div>
      </div>

      {/* Price + Date + Time */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div style={colSt}><label style={labelSt}>EXIT PRICE</label><input style={inputSt} type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" required /></div>
        <div style={colSt}><label style={labelSt}>DATE</label><input style={inputSt} type="date" value={date} onChange={e => setDate(e.target.value)} required /></div>
        <div style={colSt}><label style={labelSt}>TIME</label><input style={inputSt} type="text" value={time} onChange={e => setTime(e.target.value)} placeholder="10:32 AM" /></div>
      </div>

      {/* Reason */}
      <div style={{ ...colSt, marginBottom: 8 }}>
        <label style={labelSt}>EXIT REASON</label>
        <select style={{ ...inputSt, cursor: 'pointer' }} value={reason} onChange={e => setReason(e.target.value)}>
          {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        {isManual && <div style={{ color: '#FFD700', fontSize: 10, marginTop: 3 }}>⚠ This exit will be flagged as an OVERRIDE in your PNTHR Journal</div>}
      </div>

      {/* Note — always visible, required for MANUAL */}
      <div style={{ ...colSt, marginBottom: 8 }}>
        <label style={{ ...labelSt, color: isManual ? '#dc3545' : '#888' }}>
          {isManual ? '⚠ REQUIRED — EXPLAIN YOUR OVERRIDE' : 'NOTE (optional)'}
        </label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          placeholder={isManual ? 'What are you seeing? Why are you overriding the system?' : 'What are you seeing? (optional)'}
          style={{ ...inputSt, resize: 'vertical', border: isManual && !note.trim() ? '2px solid #dc3545' : '1px solid #333' }}
        />
      </div>

      {/* Impact preview */}
      {sharesNum > 0 && priceNum > 0 && (
        <div style={{ background: '#111', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: 11 }}>
          <div style={{ color: '#555', fontSize: 9, letterSpacing: 1, fontWeight: 700, marginBottom: 4 }}>IMPACT PREVIEW</div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <span>P&L: <b style={{ color: pnlDollar >= 0 ? '#6bcb77' : '#ff6b6b' }}>
              {pnlDollar >= 0 ? '+' : ''}${pnlDollar.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)
            </b></span>
            <span>Remaining: <b style={{ color: '#fff' }}>{Math.max(0, afterRemain)} shr</b></span>
            {afterRemain <= 0 && sharesNum > 0 && <span style={{ color: '#FFD700', fontWeight: 700 }}>⚡ FINAL EXIT</span>}
          </div>
        </div>
      )}

      {err && <div style={{ color: '#ff6b6b', fontSize: 11, marginBottom: 6 }}>{err}</div>}

      <button type="submit" disabled={submitting || !canSubmit}
        style={{ width: '100%', background: canSubmit && !submitting ? '#FFD700' : '#333', color: canSubmit && !submitting ? '#000' : '#555', border: 'none', borderRadius: 5, padding: '7px 0', fontWeight: 700, fontSize: 12, cursor: canSubmit && !submitting ? 'pointer' : 'not-allowed', letterSpacing: 1 }}>
        {submitting ? 'RECORDING…' : 'RECORD EXIT'}
      </button>
    </form>
  );
}

// ── Pyramid Card (position row) ───────────────────────────────────────────────

function PyramidCard({ position, netLiquidity, onUpdate, onUpdateStop, onUpdatePrice, onClearOverride, onDelete, onExitConfirmed, flashed, onOpenChart }) {
  const [expanded,      setExpanded]      = useState(false);
  const [editing,       setEditing]       = useState(null);
  const [ev,            setEv]            = useState({});
  const [editingStop,   setEditingStop]   = useState(false);
  const [editDirection, setEditDirection] = useState(position.direction || 'LONG');
  const [stopVal,       setStopVal]       = useState('');
  const [twsAvg,        setTwsAvg]        = useState('');
  const [ratchetRec,    setRatchetRec]    = useState(null);
  const [exitPanelOpen, setExitPanelOpen] = useState(false);
  const [localPrice,    setLocalPrice]    = useState(null); // null = not actively editing

  const sizingStop = position.originalStop || position.stopPrice;
  const pc   = sizePosition({ netLiquidity, entryPrice: position.entryPrice, stopPrice: sizingStop, maxGapPct: position.maxGapPct || 0, direction: position.direction });

  // ── Lot 1 fill recalculation ─────────────────────────────────────────────
  // If user filled Lot 1 with more/fewer shares than recommended, scale the
  // total target (and all subsequent lot targets) from the actual fill.
  const lot1Fill       = position.fills?.[1];
  const lot1Actual     = lot1Fill?.filled && lot1Fill?.shares ? +lot1Fill.shares : null;
  const lot1FillPrice  = lot1Fill?.price ? +lot1Fill.price : position.entryPrice;
  const lot1RPS        = Math.abs(lot1FillPrice - sizingStop);
  const lot1Recommended = Math.max(1, Math.round(pc.totalShares * STRIKE_PCT[0]));
  let effectiveTotal   = pc.totalShares;
  let sizeWarning      = null;
  let adjShares        = null; // null = no adjustment; array[5] = adjusted per-lot share counts

  if (lot1Actual !== null && lot1Actual !== lot1Recommended) {
    const impliedTotal    = Math.round(lot1Actual / STRIKE_PCT[0]);
    const maxByTickerCap  = lot1FillPrice > 0 ? Math.floor(netLiquidity * 0.10 / lot1FillPrice) : impliedTotal;
    const maxByVitality   = lot1RPS > 0 ? Math.floor(netLiquidity * 0.01 / lot1RPS) : impliedTotal;
    const cappedTotal     = Math.min(impliedTotal, maxByTickerCap, maxByVitality);
    effectiveTotal        = Math.max(lot1Actual, cappedTotal); // never less than what was actually bought

    // Redistribute remaining cap shares across Lots 2-5 proportionally
    const remaining = Math.max(0, effectiveTotal - lot1Actual);
    const l2 = Math.round(remaining * 30 / 85);
    const l3 = Math.round(remaining * 25 / 85);
    const l4 = Math.round(remaining * 20 / 85);
    const l5 = Math.max(0, remaining - l2 - l3 - l4); // absorb rounding remainder
    adjShares = [lot1Actual, l2, l3, l4, l5]; // index 0 = Lot 1

    if (impliedTotal > cappedTotal) {
      const impliedVal = (impliedTotal * lot1FillPrice).toLocaleString(undefined, { maximumFractionDigits: 0 });
      const capVal     = (netLiquidity * 0.10).toLocaleString(undefined, { maximumFractionDigits: 0 });
      sizeWarning = `Lot 1 fill (${lot1Actual} shr) implies ${impliedTotal} total shares ($${impliedVal}) — exceeds 10% ticker cap ($${capVal}). Subsequent lots capped to ${cappedTotal} shares.`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const rawLots = buildLots({ entryPrice: position.entryPrice, stopPrice: sizingStop, totalShares: effectiveTotal, direction: position.direction, fills: position.fills });
  const lots = enrichLots(rawLots, position.entryPrice, position.stopPrice, position.direction);
  const isLong      = position.direction === 'LONG';
  const highFilled  = Math.max(...lots.filter(l => l.filled).map(l => l.lot), 0);
  const totShr  = lots.reduce((s, l) => s + (l.filled ? l.actualShares : 0), 0);
  const totCost = lots.reduce((s, l) => s + (l.filled ? l.costBasis    : 0), 0);
  const avg     = totShr > 0 ? totCost / totShr : position.entryPrice;

  // displayPrice: uses manual override if active (and market hasn't caught up yet)
  // Used for all lot-trigger calculations and P&L display when override is active.
  const displayPrice   = getDisplayPrice(position);
  const overrideActive = !!(position.manualPriceOverride?.active);

  const pnl     = isLong ? ((displayPrice - avg) / avg * 100) : ((avg - displayPrice) / avg * 100);
  const pnl$    = isLong ? (displayPrice - avg) * totShr       : (avg - displayPrice) * totShr;
  const pC      = pnl >= 0 ? '#28a745' : '#dc3545';
  const posVal  = totShr * displayPrice;
  const next    = lots.find(l => l.lot === highFilled + 1);
  const nextDist = next ? (isLong ? (next.triggerPrice - displayPrice) / displayPrice * 100
                                  : (displayPrice - next.triggerPrice) / displayPrice * 100) : null;
  // tradingDaysActive is computed server-side from createdAt; fall back to daysActive for legacy docs
  const tradDays  = position.tradingDaysActive ?? position.daysActive ?? 0;
  const t2met     = tradDays >= 5;
  const t2blocked = highFilled === 1 && !t2met;
  // Multi-level stale: 15+=yellow, 18+=orange, 20+=red LIQUIDATE
  const staleLevel = highFilled <= 1 ? (tradDays >= 20 ? 3 : tradDays >= 18 ? 2 : tradDays >= 15 ? 1 : 0) : 0;
  const stale      = staleLevel > 0;

  const lot1P      = lots[0].actualPrice || position.entryPrice;
  const isRecycled = isLong ? position.stopPrice >= lot1P : position.stopPrice <= lot1P;
  const riskPerShr = isLong ? Math.max(avg - position.stopPrice, 0) : Math.max(position.stopPrice - avg, 0);
  const actualRisk = isRecycled ? 0 : totShr * riskPerShr;
  const pnlFloor   = isLong ? (position.stopPrice - avg) * totShr : (avg - position.stopPrice) * totShr;
  const hasFloor   = pnlFloor > 0;

  const recStop = highFilled >= 1 ? lots[Math.min(highFilled - 1, 4)].recommendedStop : position.stopPrice;
  const recStopNote   = highFilled >= 3 ? lots[Math.min(highFilled - 1, 4)].ratchetNote : null;
  const stopBelowRec  = isLong ? position.stopPrice < recStop : position.stopPrice > recStop;
  const anchorDiffers = lots[0].actualPrice && Math.abs(lots[0].actualPrice - position.entryPrice) > 0.005;

  const startEdit = (n) => {
    const l = lots.find(x => x.lot === n);
    const defaultShares = l.filled ? l.actualShares : (adjShares ? adjShares[n - 1] : l.targetShares);
    setEditing(n);
    setTwsAvg('');
    setEv({ price: l.actualPrice || l.triggerPrice, shares: defaultShares, date: l.actualDate || new Date().toISOString().split('T')[0] });
    if (n === 1) {
      setEditingStop(true);
      setStopVal(position.stopPrice.toString());
      setEditDirection(position.direction || 'LONG'); // always reset to current on open
    }
  };
  const save = (n) => {
    const nf = { ...position.fills };
    nf[n] = { filled: true, price: +ev.price, shares: +ev.shares, date: ev.date };
    // Build updates object — direction only included when it changed on Lot 1
    const updates = { fills: nf };
    if (n === 1 && editDirection !== position.direction) {
      updates.direction = editDirection;
      updates.signal    = editDirection === 'LONG' ? 'BL' : 'SS';
    }
    onUpdate(position.id, updates);
    if (n === 1 && editingStop) { const v = parseFloat(stopVal); if (v) onUpdateStop(position.id, v); }
    // Show ratchet recommendation when Lot 3, 4, or 5 is filled
    if (n >= 3) {
      const rec = checkRatchet(nf, position.direction, position.stopPrice);
      if (rec) setRatchetRec(rec);
    }
    setEditing(null); setEditingStop(false); setTwsAvg('');
  };
  const unfill = (n) => {
    const nf = { ...position.fills };
    for (let i = n; i <= 5; i++) nf[i] = { filled: false };
    onUpdate(position.id, nf); setEditing(null); setEditingStop(false);
  };
  const saveStopOnly = () => { const v = parseFloat(stopVal); if (v) onUpdateStop(position.id, v); setEditingStop(false); };
  const startStopOnly = () => { setEditingStop(true); setStopVal(position.stopPrice.toString()); };

  // Back-calculate a lot's fill price from the new TWS blended average
  const calcLotFillFromAvg = (newAvg, lotShares, priorFills) => {
    const priorShares = priorFills.reduce((s, f) => s + (+f.shares || 0), 0);
    const priorCost   = priorFills.reduce((s, f) => s + ((+f.shares || 0) * (+f.price || 0)), 0);
    const newTotal    = newAvg * (priorShares + lotShares);
    return (newTotal - priorCost) / lotShares;
  };

  // Check if a stop ratchet recommendation should show after a lot fill
  const checkRatchet = (newFills, direction, currentStop) => {
    const filledNums = Object.entries(newFills)
      .filter(([, f]) => f.filled && f.price)
      .map(([k]) => +k);
    if (!filledNums.length) return null;
    const highFilled = Math.max(...filledNums);
    const isLongDir  = direction === 'LONG';
    let recStop = null, msg = null;
    if (highFilled >= 3 && newFills[1]?.price) {
      recStop = +newFills[1].price;
      msg = `Lot 3 filled — ratchet stop to breakeven ($${recStop.toFixed(2)})`;
    }
    if (highFilled >= 4 && newFills[2]?.price) {
      recStop = +newFills[2].price;
      msg = `Lot 4 filled — lock stop to Lot 2 fill ($${recStop.toFixed(2)})`;
    }
    if (highFilled >= 5 && newFills[3]?.price) {
      recStop = +newFills[3].price;
      msg = `Lot 5 filled — lock stop to Lot 3 fill ($${recStop.toFixed(2)})`;
    }
    if (!recStop) return null;
    const needsRatchet = isLongDir ? currentStop < recStop : currentStop > recStop;
    return needsRatchet ? { recStop, msg } : null;
  };

  const staleBorderColor = staleLevel === 3 ? 'rgba(220,53,69,0.4)'
                         : staleLevel === 2 ? 'rgba(255,140,0,0.35)'
                         : staleLevel === 1 ? 'rgba(255,193,7,0.3)'
                         : 'rgba(255,255,255,0.06)';
  const staleHeaderBg   = staleLevel === 3 ? 'rgba(220,53,69,0.07)'
                         : staleLevel === 2 ? 'rgba(255,140,0,0.05)'
                         : staleLevel === 1 ? 'rgba(255,193,7,0.04)'
                         : 'transparent';

  const flashBorder = flashed ? 'rgba(255,215,0,0.75)' : staleBorderColor;
  const flashShadow = flashed ? '0 0 10px rgba(255,215,0,0.25)' : 'none';

  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${flashBorder}`,
      boxShadow: flashShadow,
      transition: 'border-color 0.6s ease, box-shadow 0.6s ease' }}>
      {/* FEAST Alert — RSI > 85: overextended, sell 50% immediately */}
      {position.feastAlert && (
        <div style={{ background: 'rgba(220,53,69,0.2)', borderBottom: '1px solid rgba(220,53,69,0.4)',
          padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 12, fontWeight: 700, letterSpacing: '0.03em' }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>⚠</span>
          <span style={{ color: '#FFD700' }}>FEAST ALERT</span>
          <span style={{ color: '#e8e6e3' }}>—</span>
          <span style={{ color: '#ff6b6b' }}>
            Weekly RSI {position.feastRSI != null ? position.feastRSI.toFixed(0) : '>85'}
          </span>
          <span style={{ color: '#e8e6e3' }}>—</span>
          <span style={{ color: '#FFD700' }}>SELL 50% IMMEDIATELY</span>
        </div>
      )}
      {/* Header */}
      <div style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: staleHeaderBg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
            onClick={() => onOpenChart?.({ ticker: position.ticker, symbol: position.ticker, currentPrice: position.currentPrice, signal: position.signal, sector: position.sector, stopPrice: position.stopPrice })}
            onMouseEnter={e => { e.currentTarget.style.color = '#FFD700'; e.currentTarget.style.textDecorationColor = '#FFD700'; }}
            onMouseLeave={e => { e.currentTarget.style.color = ''; e.currentTarget.style.textDecorationColor = 'rgba(212,160,23,0.4)'; }}
            title={`View ${position.ticker} chart`}
            style={{ fontSize: 17, fontWeight: 800, fontFamily: 'monospace', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(212,160,23,0.4)', textUnderlineOffset: 3 }}
          >{position.ticker}</span>
          <SigBadge d={position.direction} />
          {isRecycled && <Badge color="#0f5132" bg="#d1e7dd" small>RECYCLED</Badge>}
          {!isRecycled && actualRisk > 0 && <Badge color="#ffc107" bg="rgba(255,193,7,0.1)" small>${actualRisk.toFixed(0)} AT RISK</Badge>}
          {hasFloor && <Badge color="#28a745" bg="rgba(40,167,69,0.1)" small>FLOOR +${pnlFloor.toFixed(0)}</Badge>}
          {staleLevel === 3 && <Badge color="#fff" bg="rgba(220,53,69,0.5)" small>LIQUIDATE {tradDays}/20</Badge>}
          {staleLevel === 2 && <Badge color="#000" bg="rgba(255,140,0,0.75)" small>STALE {tradDays}/20</Badge>}
          {staleLevel === 1 && <Badge color="#664d03" bg="#fff3cd" small>STALE {tradDays}/20</Badge>}
          {t2blocked && <Badge color="#664d03" bg="#fff3cd" small>GATE {Math.max(0, 5 - tradDays)}d</Badge>}
          <span style={{ fontSize: 11, color: '#555' }}>{position.sector}</span>
          {/* IBKR share count mismatch warning */}
          {position.ibkrShares !== undefined && (() => {
            const pnthrShares = Object.values(position.fills || {})
              .reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
            const diff = Math.abs(position.ibkrShares) - pnthrShares;
            if (diff === 0) return null;
            return (
              <span style={{ color: '#ffc107', fontSize: 11 }}>
                ⚠ IBKR {Math.abs(position.ibkrShares)} shr (PNTHR: {pnthrShares})
              </span>
            );
          })()}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {nextDist !== null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, color: '#666' }}>Next lot</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: t2blocked ? '#ffc107' : '#FFD700', fontFamily: 'monospace' }}>
                {nextDist > 0 ? `${nextDist.toFixed(1)}% away` : 'READY'}
              </div>
            </div>
          )}
          <div style={{ textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              <span style={{ fontSize: 10, color: overrideActive ? '#FFD700' : '#666' }}>
                {overrideActive ? '📌 MANUAL' : 'Current'}
              </span>
              {overrideActive && (
                <button
                  onClick={() => onClearOverride(position.id)}
                  title="Reset to live market price"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#555', fontSize: 10, padding: '0 2px', lineHeight: 1 }}
                >✕</button>
              )}
            </div>
            <input type="number" step="0.01"
              value={localPrice ?? displayPrice.toFixed(2)}
              onChange={e => setLocalPrice(e.target.value)}
              onBlur={() => {
                const v = parseFloat(localPrice);
                if (localPrice !== null && !isNaN(v) && v > 0 && v !== displayPrice) {
                  onUpdatePrice(position.id, v);
                }
                setLocalPrice(null);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === 'Tab') {
                  const v = parseFloat(localPrice);
                  if (localPrice !== null && !isNaN(v) && v > 0 && v !== displayPrice) {
                    onUpdatePrice(position.id, v);
                  }
                  setLocalPrice(null);
                  if (e.key === 'Enter') e.target.blur();
                }
                if (e.key === 'Escape') { setLocalPrice(null); e.target.blur(); }
              }}
              style={{ background: 'rgba(255,255,255,0.06)',
                border: overrideActive ? '1px solid rgba(255,215,0,0.5)' : '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4, padding: '2px 6px',
                color: (localPrice !== null || overrideActive) ? '#FFD700' : '#e8e6e3',
                fontSize: 15, fontFamily: 'monospace', fontWeight: 700, width: 80,
                textAlign: 'right', outline: 'none',
                MozAppearance: 'textfield', WebkitAppearance: 'none' }}
              onFocus={e => { e.target.style.borderColor = '#FFD700'; e.target.style.color = '#FFD700'; }}
            />
            {overrideActive && (
              <div style={{ fontSize: 9, color: '#444', fontFamily: 'monospace', textAlign: 'right', marginTop: 1 }}>
                mkt: ${(position.currentPrice ?? 0).toFixed(2)}
              </div>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#666' }}>P&L</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'monospace', color: pC }}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(1)}%</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#666' }}>P&L $</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'monospace', color: pC }}>{pnl$ >= 0 ? '+' : ''}${Math.abs(pnl$).toFixed(0)}</div>
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {[1, 2, 3, 4, 5].map(l => (
              <div key={l} style={{ width: 16, height: 16, borderRadius: 3, fontSize: 9, display: 'flex',
                alignItems: 'center', justifyContent: 'center', fontWeight: 700,
                background: l <= highFilled ? (l === highFilled ? '#FFD700' : '#28a745') : 'rgba(255,255,255,0.06)',
                color: l <= highFilled ? '#000' : '#444' }}>
                {l}
              </div>
            ))}
          </div>
          <button onClick={() => setExpanded(!expanded)}
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4, padding: '4px 10px', cursor: 'pointer', color: '#aaa', fontSize: 12, fontWeight: 600 }}>
            {expanded ? 'CLOSE ▲' : 'ORDERS ▼'}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ padding: '0 18px 8px' }}>
        <div style={{ display: 'flex', gap: 2 }}>
          {lots.map((l, i) => (
            <div key={i} style={{ flex: l.pctLabel, height: 4, borderRadius: 2,
              background: l.filled ? '#28a745' : l.lot === highFilled + 1 ? 'rgba(255,215,0,0.35)' : 'rgba(255,255,255,0.05)' }} />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555', marginTop: 3 }}>
          <span>{totShr}/{effectiveTotal} shares · Avg: ${avg.toFixed(2)}</span>
          <span>{isRecycled ? 'RECYCLED · ' : actualRisk > 0 ? `$${actualRisk.toFixed(0)} risk · ` : ''}Value: ${posVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
      </div>

      {/* Expanded order table */}
      {expanded && (
        <div>
          <div style={{ padding: '6px 18px', display: 'flex', gap: 16, fontSize: 11, color: '#777',
            background: 'rgba(0,0,0,0.15)', borderTop: '1px solid rgba(255,255,255,0.04)',
            borderBottom: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap', alignItems: 'center' }}>
            {totShr > 0 && (
              <span style={{ fontWeight: 700, fontSize: 12 }}>
                <span style={{ color: '#555' }}>Avg Cost: </span>
                <b style={{ color: '#FFD700' }}>${avg.toFixed(2)}</b>
                <span style={{ color: '#555', fontWeight: 400 }}> ({totShr} shr)</span>
                {position.ibkrAvgCost && (() => {
                  const ibkrAvg  = +position.ibkrAvgCost;
                  const diff     = Math.abs(ibkrAvg - avg);
                  const diffPct  = avg > 0 ? diff / avg * 100 : 0;
                  if (diff < 0.01) return (
                    <span style={{ color: '#28a745', marginLeft: 6, fontSize: 10, fontWeight: 400 }}>
                      ✓ matches IBKR
                    </span>
                  );
                  if (diffPct < 0.1) return (
                    <span style={{ color: '#6ea8fe', marginLeft: 6, fontSize: 10, fontWeight: 400 }}>
                      ℹ IBKR ${ibkrAvg.toFixed(2)} (${diff.toFixed(2)} diff — likely commissions)
                    </span>
                  );
                  return (
                    <span style={{ color: '#ffc107', marginLeft: 6, fontSize: 10, fontWeight: 400, cursor: 'pointer', textDecoration: 'underline dotted' }}
                      title="Significant avg cost difference — check your lot fill prices">
                      ⚠ IBKR ${ibkrAvg.toFixed(2)} (${diff.toFixed(2)} diff — check fill prices)
                    </span>
                  );
                })()}
              </span>
            )}
            <span>Entry: <b style={{ color: '#aaa' }}>${position.entryPrice}</b></span>
            {anchorDiffers && <span>Lot 1 fill: <b style={{ color: '#FFD700' }}>${lots[0].actualPrice}</b></span>}
            <span>Stop: <b style={{ color: isRecycled ? '#28a745' : '#dc3545' }}>${position.stopPrice}</b></span>
            <span>Risk/shr: <b>${riskPerShr.toFixed(2)}</b></span>
            <span>$ at risk: <b style={{ color: actualRisk > 0 ? '#ffc107' : '#28a745' }}>${actualRisk.toFixed(0)}</b></span>
            {hasFloor && <span>P&L floor: <b style={{ color: '#28a745' }}>+${pnlFloor.toFixed(0)}</b></span>}
            <span style={{ color: staleLevel >= 2 ? '#ff8c00' : staleLevel === 1 ? '#ffc107' : undefined }}>
              Day {tradDays}/20
            </span>
            {recStopNote && stopBelowRec && <span style={{ color: '#FFD700' }}>{recStopNote}</span>}
          </div>
          {anchorDiffers && (
            <div style={{ padding: '5px 18px', fontSize: 11, color: '#FFD700',
              background: 'rgba(255,215,0,0.03)', borderBottom: '1px solid rgba(255,215,0,0.06)' }}>
              ★ Triggers cascade from Lot 1 fill: ${lots[0].actualPrice}
            </div>
          )}
          {sizeWarning && (
            <div style={{ padding: '6px 18px', fontSize: 11, color: '#ff9800',
              background: 'rgba(255,152,0,0.08)', borderBottom: '1px solid rgba(255,152,0,0.15)',
              display: 'flex', alignItems: 'center', gap: 6 }}>
              ⚠ {sizeWarning}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ fontSize: 9, color: '#555', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {['Lot', 'Name', 'Target', 'Filled', 'Trigger', 'Fill $', 'Date', 'Cost', 'Cumul', 'Avg', 'Stop $', ''].map(h => (
                  <th key={h} style={{ padding: '6px 8px', textAlign: ['Name', 'Date'].includes(h) ? 'center' : 'right', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lots.map((l, i) => {
                const isNext = l.lot === highFilled + 1;
                const gated  = isNext && l.lot === 2 && !t2met;
                const ed     = editing === l.lot;
                // Contextual lot status for badges and fill buttons
                const getLotStatus = () => {
                  if (l.filled) return 'FILLED';
                  if (l.lot === 2) {
                    if (!t2met) return 'GATE';
                    const priceReached = displayPrice &&
                      (isLong ? displayPrice >= l.triggerPrice : displayPrice <= l.triggerPrice);
                    return priceReached ? 'READY' : 'WAITING';
                  }
                  const priorFilled = position.fills?.[l.lot - 1]?.filled ?? false;
                  if (!priorFilled) return 'LOCKED';
                  const priceReached = displayPrice &&
                    (isLong ? displayPrice >= l.triggerPrice : displayPrice <= l.triggerPrice);
                  return priceReached ? 'READY' : 'WAITING';
                };
                const lotStatus = getLotStatus();
                const bg = lotStatus === 'FILLED'  ? 'rgba(40,167,69,0.04)'
                         : lotStatus === 'READY'   ? 'rgba(40,167,69,0.03)'
                         : lotStatus === 'WAITING' ? 'rgba(255,215,0,0.04)'
                         : lotStatus === 'GATE'    ? 'rgba(255,193,7,0.03)'
                         : 'transparent';
                const tc = lotStatus === 'FILLED'  ? '#28a745'
                         : lotStatus === 'READY'   ? '#28a745'
                         : lotStatus === 'WAITING' ? '#FFD700'
                         : lotStatus === 'GATE'    ? '#ffc107'
                         : '#555';
                const showStopInput = i === 0;
                return (
                  <Fragment key={i}>
                  <tr style={{ background: bg, borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td style={{ padding: '8px 8px', fontWeight: 700, color: tc, textAlign: 'right' }}>#{l.lot}</td>
                    <td style={{ padding: '8px 8px', fontFamily: 'sans-serif', fontSize: 11, fontWeight: 600, color: tc, textAlign: 'center' }}>{l.name}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', fontSize: 11 }}>
                      {adjShares && adjShares[i] !== l.targetShares ? (
                        <span style={{ whiteSpace: 'nowrap' }}>
                          <span style={{ color: '#444', textDecoration: 'line-through' }}>{l.targetShares}</span>
                          <span style={{ color: '#555' }}> → </span>
                          <span style={{ fontWeight: 700, color: l.filled ? '#888' : '#FFD700' }}>{adjShares[i]}</span>
                          <span style={{ color: '#555', fontSize: 10 }}> ({l.pctLabel}%)</span>
                        </span>
                      ) : (
                        <span style={{ color: '#666' }}>{l.targetShares} ({l.pctLabel}%)</span>
                      )}
                    </td>
                    <td style={{ padding: '4px 4px', textAlign: 'right' }}>
                      {ed ? <input type="number" value={ev.shares} onChange={e => setEv(v => ({ ...v, shares: e.target.value }))} style={{ ...fI, width: 48 }} />
                          : <span style={{ fontWeight: 700, fontSize: 13, color: l.filled ? '#e8e6e3' : '#555' }}>{l.filled ? l.actualShares : '—'}</span>}
                    </td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: '#666', fontSize: 11 }}>${l.triggerPrice} ({l.offsetPct > 0 ? `+${l.offsetPct}%` : 'entry'})</td>
                    <td style={{ padding: '4px 4px', textAlign: 'right' }}>
                      {ed ? <input type="number" step="0.01" value={ev.price} onChange={e => setEv(v => ({ ...v, price: e.target.value }))} style={{ ...fI, width: 70 }} />
                          : <span style={{ fontWeight: 700, fontSize: 13, color: l.filled ? '#FFD700' : isNext && !gated ? '#FFD700' : '#555' }}>
                              {l.filled ? `$${l.actualPrice}` : isNext ? `$${l.triggerPrice}` : '—'}
                            </span>}
                    </td>
                    <td style={{ padding: '4px 4px', textAlign: 'center' }}>
                      {ed ? <input type="date" value={ev.date} onChange={e => setEv(v => ({ ...v, date: e.target.value }))} style={{ ...fI, width: 108, textAlign: 'center', color: '#aaa', fontSize: 11 }} />
                          : <span style={{ fontSize: 11, color: '#666' }}>{l.actualDate || '—'}</span>}
                    </td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: '#777' }}>{l.filled ? `$${l.costBasis.toLocaleString()}` : '—'}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: '#aaa' }}>{l.cumShr > 0 ? l.cumShr : '—'}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: '#888' }}>{l.avgCost > 0 ? `$${l.avgCost}` : '—'}</td>
                    <td style={{ padding: '4px 4px', textAlign: 'right' }}>
                      {showStopInput ? (
                        editingStop
                          ? <input type="number" step="0.01" value={stopVal} autoFocus
                              onChange={e => setStopVal(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(stopVal); if (v) { onUpdateStop(position.id, v); setEditingStop(false); } } if (e.key === 'Escape') setEditingStop(false); }}
                              style={{ ...fI, width: 70, color: '#FFD700', border: '1px solid rgba(255,215,0,0.5)' }} />
                          : <span style={{ fontWeight: 700, fontSize: 13, color: isRecycled ? '#28a745' : '#dc3545' }}>${position.stopPrice}</span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#666' }}>${l.recommendedStop}</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                      {ed ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
                          {l.lot === 1 && (
                            <button
                              onClick={() => setEditDirection(d => d === 'LONG' ? 'SHORT' : 'LONG')}
                              title="Flip LONG ↔ SHORT"
                              style={{
                                background: editDirection === 'LONG' ? '#d1e7dd' : '#f8d7da',
                                color: editDirection === 'LONG' ? '#0f5132' : '#842029',
                                border: 'none', borderRadius: 4, padding: '3px 10px',
                                fontSize: 11, fontWeight: 700, cursor: 'pointer',
                              }}>
                              {editDirection} ⇄
                            </button>
                          )}
                          <button onClick={() => save(l.lot)} style={{ background: '#28a745', color: '#fff', border: 'none', borderRadius: 3, padding: '3px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>SAVE</button>
                          <button onClick={() => { setEditing(null); setEditingStop(false); }} style={{ background: 'none', color: '#888', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '3px 6px', fontSize: 10, cursor: 'pointer' }}>✕</button>
                        </div>
                      ) : (showStopInput && editingStop && !ed) ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          <button onClick={saveStopOnly} style={{ background: '#28a745', color: '#fff', border: 'none', borderRadius: 3, padding: '3px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>SAVE</button>
                          <button onClick={() => setEditingStop(false)} style={{ background: 'none', color: '#888', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '3px 6px', fontSize: 10, cursor: 'pointer' }}>✕</button>
                        </div>
                      ) : lotStatus === 'FILLED' ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                          <Badge color="#0f5132" bg="#d1e7dd" small>FILLED</Badge>
                          <button onClick={() => startEdit(l.lot)} style={{ background: 'none', color: '#888', border: 'none', fontSize: 10, cursor: 'pointer', textDecoration: 'underline' }}>edit</button>
                          {showStopInput && !editingStop && <button onClick={startStopOnly} style={{ background: 'none', color: '#dc3545', border: 'none', fontSize: 10, cursor: 'pointer', textDecoration: 'underline' }}>stop</button>}
                          {l.lot === highFilled && <button onClick={() => unfill(l.lot)} style={{ background: 'none', color: '#dc3545', border: 'none', fontSize: 10, cursor: 'pointer' }}>✕</button>}
                        </div>
                      ) : lotStatus === 'GATE' ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                          <Badge color="#664d03" bg="#fff3cd" small>GATE {Math.max(0, 5 - tradDays)}d</Badge>
                          <button onClick={() => startEdit(l.lot)} style={{ background: 'none', color: '#aaa', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 3, padding: '2px 8px', fontSize: 10, cursor: 'pointer' }}>FILL</button>
                        </div>
                      ) : lotStatus === 'LOCKED' ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                          <Badge color="#444" bg="rgba(255,255,255,0.05)" small>LOCKED</Badge>
                          <button onClick={() => startEdit(l.lot)} style={{ background: 'none', color: '#666', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '2px 8px', fontSize: 10, cursor: 'pointer' }}>FILL</button>
                        </div>
                      ) : lotStatus === 'WAITING' ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                          <Badge color="#666" small>WAITING</Badge>
                          <button onClick={() => startEdit(l.lot)} style={{ background: 'none', color: '#aaa', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 3, padding: '2px 8px', fontSize: 10, cursor: 'pointer' }}>FILL</button>
                        </div>
                      ) : lotStatus === 'READY' ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                          <Badge color="#0f5132" bg="#d1e7dd" small>READY</Badge>
                          <button onClick={() => startEdit(l.lot)} style={{ background: '#28a745', color: '#fff', border: 'none', borderRadius: 3, padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                            FILL LOT {l.lot}
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                  {/* TWS average back-calc helper row — shows when editing lots 2-5 */}
                  {ed && l.lot > 1 && (
                    <tr key={`${i}-tws`} style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td colSpan={12} style={{ padding: '4px 12px 8px 40px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, color: '#666' }}>Or enter TWS avg:</span>
                          <input
                            type="number" step="0.01"
                            value={twsAvg}
                            placeholder="e.g. 237.79"
                            style={{ ...fI, width: 90 }}
                            onChange={e => {
                              setTwsAvg(e.target.value);
                              const avg = +e.target.value;
                              const shr = +ev.shares;
                              if (avg > 0 && shr > 0) {
                                const priorFills = Object.values(position.fills || {}).filter(f => f.filled && f.price);
                                const calc = calcLotFillFromAvg(avg, shr, priorFills);
                                if (calc > 0) setEv(prev => ({ ...prev, price: calc.toFixed(2) }));
                              }
                            }}
                          />
                          {twsAvg && +ev.shares > 0 && (() => {
                            const priorFills = Object.values(position.fills || {}).filter(f => f.filled && f.price);
                            const calc = calcLotFillFromAvg(+twsAvg, +ev.shares, priorFills);
                            return calc > 0
                              ? <span style={{ fontSize: 11, color: '#fcf000' }}>→ Lot {l.lot} fill: <strong>${calc.toFixed(2)}</strong></span>
                              : null;
                          })()}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {/* Stop ratchet recommendation — shown after Lot 3/4/5 fill */}
          {ratchetRec && (
            <div style={{
              margin: '0 18px 8px',
              padding: '8px 12px',
              background: 'rgba(255,193,7,0.12)',
              border: '1px solid rgba(255,193,7,0.4)',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12
            }}>
              <span style={{ color: '#ffc107', flex: 1 }}>⚡ {ratchetRec.msg}</span>
              <button
                onClick={() => { onUpdateStop(position.id, ratchetRec.recStop); setRatchetRec(null); }}
                style={{ background: '#ffc107', color: '#000', border: 'none', borderRadius: 4, padding: '3px 10px', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
                RATCHET STOP
              </button>
              <button
                onClick={() => setRatchetRec(null)}
                style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>
                ✕
              </button>
            </div>
          )}
          {/* Exit Records — existing exits on this position */}
          {(position.exits || []).length > 0 && (
            <div style={{ margin: '0 18px 8px', borderTop: '1px solid #222', paddingTop: 8 }}>
              {(position.exits || []).map(ex => (
                <div key={ex.id} style={{ display: 'flex', gap: 8, fontSize: 11, color: '#aaa', padding: '2px 0', alignItems: 'center' }}>
                  <span style={{ color: '#555', minWidth: 24 }}>{ex.id}</span>
                  <span style={{ minWidth: 60 }}>{ex.shares} shr @ ${ex.price?.toFixed(2)}</span>
                  <span style={{ minWidth: 60 }}>{ex.date}</span>
                  <span style={{ color: ex.reason === 'MANUAL' ? '#ff8c00' : '#6bcb77', fontWeight: 700 }}>{ex.reason}{ex.isOverride ? ' ⚠' : ''}</span>
                  <span style={{ color: ex.pnl?.dollar >= 0 ? '#6bcb77' : '#ff6b6b', marginLeft: 'auto' }}>
                    {ex.pnl?.dollar >= 0 ? '+' : ''}{ex.pnl?.dollar?.toFixed(2)} ({ex.pnl?.pct >= 0 ? '+' : ''}{ex.pnl?.pct?.toFixed(1)}%)
                  </span>
                </div>
              ))}
              {position.remainingShares != null && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#888', display: 'flex', gap: 16 }}>
                  <span>Remaining: <b style={{ color: '#fff' }}>{position.remainingShares} of {position.totalFilledShares} shr</b></span>
                  {position.realizedPnl?.dollar != null && (
                    <span>Realized: <b style={{ color: position.realizedPnl.dollar >= 0 ? '#6bcb77' : '#ff6b6b' }}>
                      {position.realizedPnl.dollar >= 0 ? '+' : ''}${position.realizedPnl.dollar.toFixed(2)}
                    </b></span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* EXIT SHARES button */}
          {(position.remainingShares == null || position.remainingShares > 0) && (
            <div style={{ margin: '0 18px 8px', textAlign: 'center' }}>
              <button
                onClick={() => setExitPanelOpen(p => !p)}
                style={{ background: 'transparent', border: '1px solid #FFD700', color: '#FFD700', borderRadius: 6, padding: '5px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}
              >
                {exitPanelOpen ? '✕ CANCEL' : '+ EXIT SHARES'}
              </button>
            </div>
          )}

          {/* Exit Panel */}
          {exitPanelOpen && (
            <div style={{ margin: '0 18px 8px' }}>
              <ExitPanel
                position={position}
                onClose={() => setExitPanelOpen(false)}
                onConfirm={async (exitData) => {
                  const res = await fetch(`${API_BASE}/api/positions/${position.id}/exit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify(exitData),
                  });
                  if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
                  const result = await res.json();
                  setExitPanelOpen(false);
                  onExitConfirmed?.(result);
                }}
              />
            </div>
          )}

          {/* Delete position — hard remove from DB */}
          <div style={{ padding: '10px 18px', borderTop: '1px solid rgba(255,255,255,0.04)',
            display: 'flex', justifyContent: 'flex-end' }}>
            <DeleteBtn onDelete={() => onDelete(position.id)} />
          </div>
        </div>
      )}
    </div>
  );
}

function DeleteBtn({ onDelete }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <button onClick={() => setConfirm(true)}
        style={{ background: 'none', border: '1px solid rgba(220,53,69,0.3)', color: 'rgba(220,53,69,0.6)',
          borderRadius: 4, padding: '4px 12px', fontSize: 11, cursor: 'pointer', letterSpacing: '0.04em' }}>
        DELETE POSITION
      </button>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, color: '#dc3545' }}>Permanently delete?</span>
      <button onClick={onDelete}
        style={{ background: '#dc3545', border: 'none', color: '#fff',
          borderRadius: 4, padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
        YES, DELETE
      </button>
      <button onClick={() => setConfirm(false)}
        style={{ background: 'none', border: '1px solid rgba(255,255,255,0.12)', color: '#666',
          borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>
        Cancel
      </button>
    </div>
  );
}

// ── Pending Entry Card ────────────────────────────────────────────────────────

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

function PendingCard({ entry, nav, onConfirm, onDismiss }) {
  const [fillPrice, setFillPrice] = useState(String(entry.currentPrice || ''));
  const [shares,    setShares]    = useState(String(entry.lot1Shares || ''));
  const [date,      setDate]      = useState(new Date().toISOString().split('T')[0]);
  const [stop,      setStop]      = useState(String(entry.adjustedStop || entry.suggestedStop || ''));
  const [direction, setDirection] = useState(entry.direction || 'LONG');
  const [saving,    setSaving]    = useState(false);
  const stopUserEdited            = useRef(false);

  // On mount: fetch live PNTHR stop for this ticker and use it as the default
  // (unless the user has already edited the stop field manually)
  useEffect(() => {
    let cancelled = false;
    async function fetchLiveStop() {
      try {
        const res  = await fetch(`${API_BASE}/api/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ tickers: [entry.ticker] }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const s    = data[entry.ticker.toUpperCase()];
        const liveStop = s?.pnthrStop ?? s?.stopPrice ?? null;
        if (liveStop && !stopUserEdited.current) {
          setStop(String(liveStop));
        }
      } catch { /* non-fatal — keep queued stop */ }
    }
    fetchLiveStop();
    return () => { cancelled = true; };
  }, [entry.ticker]); // eslint-disable-line react-hooks/exhaustive-deps

  const isExpired  = Date.now() - new Date(entry.queuedAt).getTime() > FIVE_DAYS_MS;
  const isLong     = direction === 'LONG';

  // Preview lot 2 / lot 3 triggers from current fill price
  const previewLots = fillPrice && +fillPrice > 0 ? buildLots({
    entryPrice: +fillPrice, stopPrice: +stop || entry.adjustedStop || entry.suggestedStop || 0,
    totalShares: entry.totalTargetShares || 1, direction, fills: {},
  }) : null;

  const handleConfirm = async () => {
    if (!fillPrice || !shares) return;
    setSaving(true);
    try {
      await onConfirm(entry.id, { fillPrice: +fillPrice, shares: +shares, date, stop: +stop || undefined, direction });
    } catch { /* non-fatal */ }
    setSaving(false);
  };

  const fI2 = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,215,0,0.3)',
    borderRadius: 4, padding: '4px 8px', color: '#FFD700', fontSize: 12,
    fontFamily: 'monospace', outline: 'none', textAlign: 'right' };

  return (
    <div style={{ borderRadius: 10, overflow: 'hidden',
      border: '1px dashed rgba(255,215,0,0.4)',
      background: 'rgba(255,215,0,0.02)',
      opacity: isExpired ? 0.6 : 1 }}>
      {/* Card header */}
      <div style={{ padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(255,215,0,0.04)', borderBottom: '1px dashed rgba(255,215,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16, fontWeight: 800, fontFamily: 'monospace', color: '#FFD700' }}>{entry.ticker}</span>
          {/* Direction toggle — click to flip LONG ↔ SHORT */}
          <button onClick={() => setDirection(d => d === 'LONG' ? 'SHORT' : 'LONG')}
            title="Click to flip direction"
            style={{ background: isLong ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
              border: `1px solid ${isLong ? '#28a745' : '#dc3545'}`,
              color: isLong ? '#28a745' : '#dc3545',
              borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 800,
              cursor: 'pointer', letterSpacing: '0.05em', userSelect: 'none' }}>
            {direction} ⇄
          </button>
          {entry.killTier && <TierBadge t={entry.killTier} />}
          {entry.sector && <span style={{ fontSize: 11, color: '#555' }}>{entry.sector}</span>}
          {entry.killScore != null && <span style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>Score: {entry.killScore}</span>}
          {isExpired && <Badge color="#fff" bg="rgba(220,53,69,0.4)" small>EXPIRED</Badge>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleConfirm} disabled={saving || !fillPrice || !shares}
            style={{ background: saving ? 'rgba(40,167,69,0.3)' : '#28a745', color: '#fff',
              border: 'none', borderRadius: 5, padding: '5px 14px', fontWeight: 700,
              fontSize: 11, cursor: saving ? 'not-allowed' : 'pointer', letterSpacing: '0.04em' }}>
            {saving ? '…' : 'CONFIRM ENTRY ✓'}
          </button>
          <button onClick={() => onDismiss(entry.id)}
            style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', color: '#666',
              borderRadius: 5, padding: '5px 10px', fontSize: 11, cursor: 'pointer' }}>
            DISMISS ✕
          </button>
        </div>
      </div>
      {/* Fill fields */}
      <div style={{ padding: '10px 18px', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 9, color: '#666', marginBottom: 2, textTransform: 'uppercase' }}>Fill Price</div>
          <input type="number" step="0.01" value={fillPrice} onChange={e => setFillPrice(e.target.value)}
            style={{ ...fI2, width: 72 }} placeholder={String(entry.currentPrice || '')} />
        </div>
        <div>
          <div style={{ fontSize: 9, color: '#666', marginBottom: 2, textTransform: 'uppercase' }}>Shares (Lot 1)</div>
          <input type="number" value={shares} onChange={e => setShares(e.target.value)}
            style={{ ...fI2, width: 56 }} />
        </div>
        <div>
          <div style={{ fontSize: 9, color: '#666', marginBottom: 2, textTransform: 'uppercase' }}>Date</div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ ...fI2, width: 112, color: '#aaa', fontSize: 11 }} />
        </div>
        <div>
          <div style={{ fontSize: 9, color: '#666', marginBottom: 2, textTransform: 'uppercase' }}>Stop <span style={{ color: '#28a745', fontSize: 8 }}>PNTHR</span></div>
          <input type="number" step="0.01" value={stop}
            onChange={e => { stopUserEdited.current = true; setStop(e.target.value); }}
            style={{ ...fI2, width: 80, borderColor: 'rgba(220,53,69,0.35)', color: '#dc3545' }} />
        </div>
        {previewLots && (
          <div style={{ fontSize: 11, color: '#555', fontFamily: 'monospace' }}>
            Lot 2 trigger: <span style={{ color: '#888' }}>${previewLots[1]?.triggerPrice}</span>
            {' · '}
            Lot 3: <span style={{ color: '#888' }}>${previewLots[2]?.triggerPrice}</span>
            {' · '}
            Total target: <span style={{ color: '#888' }}>{entry.totalTargetShares} shr</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── New Position Calculator ───────────────────────────────────────────────────

function Calculator({ netLiquidity, onCreate }) {
  const [f,       setF]       = useState({ ticker: '', entry: '', stop: '', gap: '', dir: 'LONG', sector: '' });
  const [result,  setResult]  = useState(null);
  const [loading, setLoading] = useState(false);

  const is = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6, padding: '8px 12px', color: '#e8e6e3', fontSize: 13, fontFamily: 'monospace',
    width: '100%', outline: 'none' };

  // Auto-populate from /api/ticker/:symbol when ticker is entered
  const lookupTicker = async (ticker) => {
    if (ticker.length < 2) return;
    setLoading(true);
    try {
      const data = await apiGet(`/api/ticker/${ticker}`);
      if (data.found) {
        setF(prev => ({
          ...prev,
          entry:  data.currentPrice?.toFixed(2) || prev.entry,
          gap:    data.maxGapPct?.toFixed(1)    || prev.gap,
          dir:    data.suggestedDirection === 'SHORT' ? 'SHORT' : 'LONG',
          sector: data.sector || prev.sector,
        }));
      }
    } catch { /* ok — user fills manually */ }
    setLoading(false);
  };

  const calc = () => {
    if (!f.entry || !f.stop) return;
    const p = sizePosition({ netLiquidity, entryPrice: +f.entry, stopPrice: +f.stop, maxGapPct: +f.gap || 0, direction: f.dir });
    const l = buildLots({ entryPrice: +f.entry, stopPrice: +f.stop, totalShares: p.totalShares, direction: f.dir });
    setResult({ ...p, lots: enrichLots(l, +f.entry, +f.stop, f.dir), dir: f.dir, entry: +f.entry, stop: +f.stop });
  };

  const isL = f.dir === 'LONG';

  return (
    <div>
      <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 10, padding: 20, border: '1px solid rgba(255,255,255,0.06)', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}><span style={{ color: '#FFD700' }}>+</span> New position</span>
          <Badge color="#FFD700" bg="rgba(255,215,0,0.08)" small>TIER A · 15-30-25-20-10</Badge>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 0.8fr 0.8fr auto', gap: 10, alignItems: 'end' }}>
          <div>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Ticker</div>
            <input value={f.ticker} placeholder="FICO" onChange={e => setF(x => ({ ...x, ticker: e.target.value.toUpperCase() }))}
              onBlur={e => { if (e.target.value.length >= 2) lookupTicker(e.target.value); }}
              onKeyDown={e => { if (e.key === 'Tab' || e.key === 'Enter') lookupTicker(f.ticker); }}
              style={{ ...is, borderColor: loading ? 'rgba(255,215,0,0.4)' : undefined }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Entry {loading && <span style={{ color: '#FFD700' }}>⟳</span>}</div>
            <input value={f.entry} placeholder="125.00" type="number" onChange={e => setF(x => ({ ...x, entry: e.target.value }))} style={is} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Stop</div>
            <input value={f.stop} placeholder="115.00" type="number" onChange={e => setF(x => ({ ...x, stop: e.target.value }))} style={is} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Gap %</div>
            <input value={f.gap} placeholder="4.2" type="number" onChange={e => setF(x => ({ ...x, gap: e.target.value }))} style={is} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase' }}>Dir</div>
            <select value={f.dir} onChange={e => setF(x => ({ ...x, dir: e.target.value }))} style={{ ...is, fontFamily: 'sans-serif' }}>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </div>
          <button onClick={calc} style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 700, fontSize: 13, cursor: 'pointer', height: 38 }}>SIZE IT</button>
        </div>
      </div>
      {result && (
        <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20, fontWeight: 800, fontFamily: 'monospace' }}>{f.ticker || '—'}</span>
              <SigBadge d={f.dir} />
              {result.gapProne && <Badge color="#664d03" bg="#fff3cd" small>GAP PRONE</Badge>}
            </div>
            <div style={{ display: 'flex', gap: 20 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: '#666' }}>Total</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#FFD700', fontFamily: 'monospace' }}>{result.totalShares} shr</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: '#666' }}>Max risk</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#28a745', fontFamily: 'monospace' }}>${result.maxRisk$.toLocaleString()}</div>
              </div>
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ fontSize: 9, color: '#555', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {['Lot','Name','Shares','%', isL ? 'Buy @' : 'Short @', '+%', 'Cost', 'Cumul', 'Avg', 'Rec stop', 'Order'].map(h => (
                  <th key={h} style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.lots.map((l, i) => (
                <tr key={i} style={{ background: i === 0 ? 'rgba(255,215,0,0.04)' : 'transparent', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '10px 8px', fontWeight: 700, color: i === 0 ? '#FFD700' : '#aaa', textAlign: 'right' }}>#{l.lot}</td>
                  <td style={{ padding: '10px 8px', fontFamily: 'sans-serif', fontSize: 11, fontWeight: 600, color: i === 0 ? '#FFD700' : '#aaa', textAlign: 'right' }}>{l.name}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', fontWeight: 700, fontSize: 14 }}>{l.targetShares}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#777' }}>{l.pctLabel}%</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', fontWeight: 700, color: '#FFD700', fontSize: 14 }}>${l.triggerPrice}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#666' }}>{l.offsetPct > 0 ? `+${l.offsetPct}%` : 'entry'}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#777' }}>${(l.targetShares * l.triggerPrice).toFixed(0)}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#aaa' }}>{result.lots.slice(0, i + 1).reduce((s, x) => s + x.targetShares, 0)}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#888' }}>${l.avgCost || l.triggerPrice}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', color: '#888', fontSize: 11 }}>${l.recommendedStop}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                    {i === 0 ? <Badge color="#000" bg="#FFD700" small>MARKET</Badge>
                    : i === 1 ? <Badge color="#664d03" bg="#fff3cd" small>{isL ? 'BUY' : 'SELL'}+5D</Badge>
                    : <Badge color="#FFD700" bg="rgba(255,215,0,0.1)" small>{isL ? 'BUY' : 'SELL'} LMT</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '12px 20px', background: 'rgba(0,0,0,0.15)', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: '#666' }}>Entry: ${result.entry} · Stop: ${result.stop} · Risk: {result.structRisk}% · Gap: {result.gapMult}×</span>
            <button
              onClick={() => {
                const fills = { 1: { filled: true, price: result.entry, shares: result.lots[0].targetShares, date: new Date().toISOString().split('T')[0] } };
                for (let i = 2; i <= 5; i++) fills[i] = { filled: false };
                onCreate({ ticker: f.ticker || 'NEW', direction: f.dir, entryPrice: result.entry, originalStop: result.stop, stopPrice: result.stop, maxGapPct: +f.gap || 0, currentPrice: result.entry, fills, sector: f.sector || '—', daysActive: 0 });
              }}
              style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
              ADD TO PORTFOLIO
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Kill Pipeline Tab ─────────────────────────────────────────────────────────

function PipelineTab({ positions, nav }) {
  const [signals,  setSignals]  = useState([]);
  const [weekOf,   setWeekOf]   = useState(null);
  const [regime,   setRegime]   = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  useEffect(() => {
    setLoading(true);
    apiGet('/api/kill-pipeline?confirmed=false&limit=50')
      .then(data => {
        setSignals(data.signals || []);
        setWeekOf(data.weekOf);
        setRegime(data.regime);
        setLoading(false);
      })
      .catch(e => {
        // Fallback: try to use the existing /api/apex data
        setError('Pipeline data not yet available. Run the Friday pipeline or visit PNTHR Kill to generate scores.');
        setLoading(false);
      });
  }, []);

  const inPort = new Set(positions.map(p => p.ticker));
  const heat   = calcHeat(positions, nav);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#555' }}>Loading Kill pipeline...</div>;

  if (error || signals.length === 0) {
    return (
      <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 10, padding: 32, border: '1px solid rgba(255,255,255,0.06)', textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>⚡</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#FFD700', marginBottom: 8 }}>Kill Pipeline — No Data Yet</div>
        <div style={{ fontSize: 12, color: '#666', maxWidth: 480, margin: '0 auto', lineHeight: 1.6 }}>
          {error || 'The Friday pipeline runs automatically at 4:15 PM ET each Friday. Visit the PNTHR Kill page to force a refresh, then check back here.'}
        </div>
      </div>
    );
  }

  return (
    <div>
      {regime && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <Badge color="#888" small>{regime.indexPosition?.toUpperCase()} · {regime.indexSlope?.toUpperCase()}</Badge>
          <Badge color="#888" small>BL: {regime.blCount} · SS: {regime.ssCount}</Badge>
          {weekOf && <Badge color="#555" small>Week of {weekOf}</Badge>}
          <Badge color="#FFD700" bg="rgba(255,215,0,0.08)" small>{heat.totalRiskPct}% risk used · {heat.liveCnt} live</Badge>
        </div>
      )}
      <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 14, fontWeight: 600 }}>
          <span style={{ color: '#FFD700' }}>⚡</span> Kill pipeline — {signals.length} signals
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'monospace' }}>
          <thead>
            <tr style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              {['#', 'Ticker', 'Dir', 'Tier', 'Score', 'Price', 'Conv', 'Slope', 'Sep', 'Age', ''].map(h => (
                <th key={h} style={{ padding: '7px 8px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {signals.map((s, i) => (
              <tr key={s.ticker} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', opacity: inPort.has(s.ticker) ? 0.4 : 1,
                background: s.tier === 'ALPHA PNTHR KILL' ? 'rgba(255,215,0,0.04)' : 'transparent' }}>
                <td style={{ padding: '10px 8px', color: '#666' }}>{i + 1}</td>
                <td style={{ padding: '10px 8px', fontWeight: 700 }}>{s.ticker}</td>
                <td style={{ padding: '10px 8px' }}><SigBadge d={s.signal === 'BL' ? 'LONG' : 'SHORT'} /></td>
                <td style={{ padding: '10px 8px' }}><TierBadge t={s.tier} /></td>
                <td style={{ padding: '10px 8px', fontWeight: 700, color: s.score >= 100 ? '#FFD700' : '#e8e6e3' }}>{s.score}</td>
                <td style={{ padding: '10px 8px', color: '#aaa' }}>{s.price ? `$${s.price.toFixed(0)}` : '—'}</td>
                <td style={{ padding: '10px 8px', color: (s.convPct || 0) >= 8 ? '#28a745' : '#aaa' }}>{s.convPct?.toFixed(1) || '—'}%</td>
                <td style={{ padding: '10px 8px', color: '#aaa' }}>{s.slopePct != null ? `${s.slopePct > 0 ? '+' : ''}${s.slopePct}` : '—'}</td>
                <td style={{ padding: '10px 8px', color: '#aaa' }}>{s.sepPct?.toFixed(1) || '—'}%</td>
                <td style={{ padding: '10px 8px', color: '#777', fontSize: 11 }}>{s.signalAge === 0 ? <Badge color="#28a745" bg="rgba(40,167,69,0.1)" small>NEW</Badge> : `${s.signalAge}w`}</td>
                <td style={{ padding: '10px 8px' }}>
                  {inPort.has(s.ticker)
                    ? <Badge color="#555" small>IN PORT</Badge>
                    : <Badge color="#FFD700" bg="rgba(255,215,0,0.1)" small>SIZE IT</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Market Hours Helper ───────────────────────────────────────────────────────

function isMarketHours() {
  try {
    const now = new Date();
    const dow = now.getDay();
    if (dow === 0 || dow === 6) return false;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(now);
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const mins = h * 60 + m;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  } catch { return false; }
}

// ── Main Command Center ───────────────────────────────────────────────────────

export default function CommandCenter({ onNavigate }) {
  const { currentUser, updateCurrentUser } = useAuth();
  const [nav,           setNav]           = useState(() => currentUser?.accountSize ?? 100000);
  const navSaveTimer    = useRef(null);
  const navLastEditedAt = useRef(0); // timestamp of last manual NAV edit

  // Debounce-save nav to profile whenever it changes (1s after last keystroke)
  function handleNavChange(value) {
    setNav(value);
    navLastEditedAt.current = Date.now(); // mark manual edit so auto-sync won't overwrite
    if (navSaveTimer.current) clearTimeout(navSaveTimer.current);
    navSaveTimer.current = setTimeout(() => {
      updateUserProfile({ accountSize: value })
        .then(() => updateCurrentUser({ accountSize: value }))
        .catch(() => {}); // silent — UI still works even if save fails
    }, 1000);
  }
  const [positions,       setPositions]       = useState([]);
  const [pendingEntries,  setPendingEntries]  = useState([]);
  const [tab,             setTab]             = useState('positions');
  const [loading,         setLoading]         = useState(true);
  const [saving,          setSaving]          = useState(false);
  const [sectorWarning,   setSectorWarning]   = useState(null);
  const [chartModal,      setChartModal]      = useState(null); // { stocks, index }
  const [closedToast,     setClosedToast]     = useState(null); // { ticker, avgCost, exitPrice, pnlDollar, pnlPct }

  const heat        = useMemo(() => calcHeat(positions, nav),        [positions, nav]);
  const advisorRecs = useMemo(() => runRiskAdvisor(positions, nav), [positions, nav]);

  // ── Auto-refresh state ─────────────────────────────────────────────────────
  const [lastRefresh,    setLastRefresh]    = useState(null);
  const [refreshing,     setRefreshing]     = useState(false);
  const [flashedTickers, setFlashedTickers] = useState(new Set());
  const refreshFnRef  = useRef(null);
  const flashTimerRef = useRef(null);

  // ── Safe price-only merge ─────────────────────────────────────────────────
  // NEVER replace positions wholesale from a server response — that would
  // overwrite sacred user-edited fields (fills, stopPrice, entryPrice, etc.)
  // that may have been updated locally but not yet round-tripped.
  //
  // Sacred fields — NEVER overwrite from a server fetch:
  //   fills[1-5].price/shares/date/filled, stopPrice, originalStop,
  //   entryPrice, direction, signal, exits[].price/shares
  //
  // Safe to overwrite from server:
  //   currentPrice, ibkrAvgCost, ibkrShares, ibkrSyncedAt, ibkrUnrealizedPNL,
  //   ibkrMarketValue, priceSource, dayHigh, dayLow,
  //   tradingDaysActive, feastAlert, feastRSI
  const mergeServerPrices = useCallback((prev, serverPositions) => {
    const freshMap = {};
    for (const fp of serverPositions) freshMap[fp.id] = fp;
    return prev.map(p => {
      const fp = freshMap[p.id];
      if (!fp) return p;
      // Spread kept fields from prev (preserves sacred fields),
      // then only patch the safe auto-update fields from server.
      return {
        ...p, // ← sacred fields come from local state, NOT server
        currentPrice:       fp.currentPrice       ?? p.currentPrice,
        priceSource:        fp.priceSource        ?? p.priceSource,
        dayHigh:            fp.dayHigh            ?? p.dayHigh,
        dayLow:             fp.dayLow             ?? p.dayLow,
        ibkrAvgCost:        fp.ibkrAvgCost        ?? p.ibkrAvgCost,
        ibkrShares:         fp.ibkrShares         ?? p.ibkrShares,
        ibkrSyncedAt:       fp.ibkrSyncedAt       ?? p.ibkrSyncedAt,
        ibkrUnrealizedPNL:  fp.ibkrUnrealizedPNL  ?? p.ibkrUnrealizedPNL,
        ibkrMarketValue:    fp.ibkrMarketValue     ?? p.ibkrMarketValue,
        tradingDaysActive:  fp.tradingDaysActive   ?? p.tradingDaysActive,
        feastAlert:         fp.feastAlert          ?? p.feastAlert,
        feastRSI:           fp.feastRSI            ?? p.feastRSI,
      };
    });
  }, []);

  // ── Merge after a partial/full exit ──────────────────────────────────────
  // Like mergeServerPrices but also syncs server-authoritative exit-tracking
  // fields (status, exits[], remainingShares, realizedPnl, closedAt).
  // Sacred user-edited fields (fills, stopPrice, entryPrice, direction, etc.)
  // are still taken from local state, not the server response.
  const mergeAfterExit = useCallback((prev, serverPositions) => {
    const freshMap = {};
    for (const fp of serverPositions) freshMap[fp.id] = fp;
    return prev.map(p => {
      const fp = freshMap[p.id];
      if (!fp) return p;
      return {
        ...p, // sacred fields from local state
        // Price / IBKR fields
        currentPrice:       fp.currentPrice       ?? p.currentPrice,
        priceSource:        fp.priceSource        ?? p.priceSource,
        dayHigh:            fp.dayHigh            ?? p.dayHigh,
        dayLow:             fp.dayLow             ?? p.dayLow,
        ibkrAvgCost:        fp.ibkrAvgCost        ?? p.ibkrAvgCost,
        ibkrShares:         fp.ibkrShares         ?? p.ibkrShares,
        ibkrSyncedAt:       fp.ibkrSyncedAt       ?? p.ibkrSyncedAt,
        ibkrUnrealizedPNL:  fp.ibkrUnrealizedPNL  ?? p.ibkrUnrealizedPNL,
        ibkrMarketValue:    fp.ibkrMarketValue     ?? p.ibkrMarketValue,
        tradingDaysActive:  fp.tradingDaysActive   ?? p.tradingDaysActive,
        feastAlert:         fp.feastAlert          ?? p.feastAlert,
        feastRSI:           fp.feastRSI            ?? p.feastRSI,
        // Exit-tracking fields — server is authoritative after recordExit writes
        status:             fp.status              ?? p.status,
        exits:              fp.exits               ?? p.exits,
        remainingShares:    fp.remainingShares     ?? p.remainingShares,
        totalExitedShares:  fp.totalExitedShares   ?? p.totalExitedShares,
        totalFilledShares:  fp.totalFilledShares   ?? p.totalFilledShares,
        avgExitPrice:       fp.avgExitPrice        ?? p.avgExitPrice,
        realizedPnl:        fp.realizedPnl         ?? p.realizedPnl,
        closedAt:           fp.closedAt            ?? p.closedAt,
        washRule:           fp.washRule            ?? p.washRule,
        outcome:            fp.outcome             ?? p.outcome,
      };
    });
  }, []);

  // ── Surgical patch — sends ONLY the specified fields ──────────────────────
  // Safe for concurrent updates because each call touches different fields.
  // Two racing patches to fills vs stopPrice can never overwrite each other.
  // MUST be declared before refreshPrices (used in its dep array + body).
  const patchPosition = useCallback(async (id, fields) => {
    setSaving(true);
    try {
      await apiPost('/api/positions', { id, ...fields });
    } catch { /* non-fatal */ }
    setSaving(false);
  }, []);

  const refreshPrices = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const data = await apiGet('/api/positions');
      if (data.positions?.length) {
        // Collect IDs where the market just caught up to a manual override
        // (computed outside setPositions so we can patch DB after state update)
        const toDeactivate = [];
        setPositions(prev => {
          // Track price changes for flash animation before merging
          const changed = new Set();
          for (const fp of data.positions) {
            const local = prev.find(p => p.id === fp.id);
            if (local && fp.currentPrice !== local.currentPrice) changed.add(local.ticker);
          }
          if (changed.size > 0) {
            setFlashedTickers(changed);
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            flashTimerRef.current = setTimeout(() => setFlashedTickers(new Set()), 2500);
          }
          // Use safe merge — never overwrite sacred fields (fills, stops, etc.)
          const merged = mergeServerPrices(prev, data.positions);
          // Auto-deactivate overrides when FMP price comes within 0.1% of the override
          // (i.e. the data feed caught up to what the user typed). No direction logic —
          // the user may enter a price in either direction relative to the stale feed.
          return merged.map(p => {
            const ov = p.manualPriceOverride;
            if (!ov?.active) return p;
            const livePrice = p.currentPrice ?? 0;
            if (!livePrice || !ov.price) return p;
            const pctDiff = Math.abs(livePrice - ov.price) / ov.price;
            if (pctDiff > 0.001) return p; // FMP hasn't caught up yet — keep override
            toDeactivate.push(p.id);
            return { ...p, manualPriceOverride: { ...ov, active: false } };
          });
        });
        // Patch DB for any auto-deactivated overrides (outside state update, safe)
        for (const id of toDeactivate) {
          patchPosition(id, { 'manualPriceOverride.active': false }).catch(() => {});
        }
      }
      setLastRefresh(new Date());
      // Sync NAV from server (picks up IBKR NetLiquidation updates)
      // Skip if user manually edited NAV in the last 10s to avoid race-condition overwrite
      try {
        if (Date.now() - navLastEditedAt.current > 10000) {
          const profile = await fetchNav();
          if (profile?.nav && profile.nav !== nav) {
            setNav(profile.nav);
            updateCurrentUser({ accountSize: profile.nav });
          }
        }
      } catch { /* silent */ }
      // Re-sync pending entries so queue is never stale after a remount or nav change
      try {
        const fresh = await fetchPendingEntries();
        if (Array.isArray(fresh)) setPendingEntries(fresh);
      } catch { /* silent */ }
    } catch { /* silent — prices stay as-is */ }
    setRefreshing(false);
  }, [refreshing, nav, mergeServerPrices, patchPosition]);

  // Keep ref in sync so the interval always calls the latest closure
  useEffect(() => { refreshFnRef.current = refreshPrices; }, [refreshPrices]);

  // 60-second auto-refresh during market hours only
  useEffect(() => {
    const timer = setInterval(() => {
      if (isMarketHours()) refreshFnRef.current?.();
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // Load positions, pending entries, and NAV on mount
  useEffect(() => {
    apiGet('/api/positions')
      .then(data => {
        if (data.positions?.length) setPositions(data.positions);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    fetchPendingEntries()
      .then(data => { if (Array.isArray(data)) setPendingEntries(data); })
      .catch(() => {});
    // Pull latest NAV on mount (picks up IBKR sync that happened before opening Command)
    fetchNav()
      .then(profile => {
        if (profile?.nav) {
          setNav(profile.nav);
          updateCurrentUser({ accountSize: profile.nav });
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Full-document save — used ONLY for new position creation ─────────────────
  // Do NOT use this for updates — it sends the full position object which can
  // race with concurrent saves and overwrite fields edited by another call.
  const persistPosition = useCallback(async (position) => {
    setSaving(true);
    try {
      await apiPost('/api/positions', position);
    } catch { /* non-fatal — UI stays updated */ }
    setSaving(false);
  }, []);

  const updateFills = useCallback((id, updates) => {
    // updates may be a plain fills object (legacy) or { fills, direction, signal }
    const fills       = updates?.fills ?? updates;
    const extraFields = updates?.fills ? { direction: updates.direction, signal: updates.signal } : {};
    // strip undefined keys so we don't overwrite good values with undefined
    Object.keys(extraFields).forEach(k => extraFields[k] === undefined && delete extraFields[k]);
    // State update (local, instant)
    setPositions(prev => prev.map(x => x.id === id ? { ...x, fills, ...extraFields } : x));
    // Surgical save — only sends fills (and optional direction/signal), never the full position.
    // This prevents a concurrent updateStop from overwriting fills, and vice-versa.
    patchPosition(id, { fills, ...extraFields });
  }, [patchPosition]);

  const updateStop = useCallback((id, newStop) => {
    // State update (local, instant)
    setPositions(prev => prev.map(x => x.id === id ? { ...x, stopPrice: newStop } : x));
    // Surgical save — only sends stopPrice. Never touches fills or entryPrice.
    patchPosition(id, { stopPrice: newStop });
  }, [patchPosition]);

  const updatePrice = useCallback((id, newPrice) => {
    // Save as a manual override — persists through price refreshes until
    // the live market price reaches the override level (or user clears it).
    const override = { price: newPrice, setAt: new Date().toISOString(), active: true };
    setPositions(prev => prev.map(x => x.id === id ? { ...x, manualPriceOverride: override } : x));
    patchPosition(id, { manualPriceOverride: override });
  }, [patchPosition]);

  const clearOverride = useCallback((id) => {
    setPositions(prev => prev.map(x => x.id === id
      ? { ...x, manualPriceOverride: x.manualPriceOverride ? { ...x.manualPriceOverride, active: false } : null }
      : x));
    patchPosition(id, { 'manualPriceOverride.active': false });
  }, [patchPosition]);

  const handleDeletePosition = useCallback(async (id) => {
    try {
      await deletePosition(id);
      setPositions(prev => prev.filter(x => x.id !== id));
    } catch (err) {
      console.error('[CC] Delete position failed:', err);
    }
  }, []);

  const createPosition = useCallback(async (data) => {
    const pos = { id: Date.now(), ...data };
    setPositions(prev => [...prev, pos]);
    setTab('positions');
    try {
      const result = await apiPost('/api/positions', pos);
      if (result.warning?.type === 'SECTOR_CONCENTRATION') {
        setSectorWarning(result.warning.message);
        setTimeout(() => setSectorWarning(null), 10000);
      }
    } catch { /* non-fatal */ }
  }, [setSectorWarning]);

  const handleConfirmEntry = useCallback(async (id, fillData) => {
    await confirmPendingEntry(id, fillData);
    setPendingEntries(prev => prev.filter(e => e.id !== id));
    // Re-fetch positions so the new one appears immediately.
    // Use safe merge so existing positions keep their sacred fields (fills, stops, etc.)
    // The newly confirmed position has no prior local state so it's appended cleanly.
    apiGet('/api/positions')
      .then(data => {
        if (!data.positions?.length) return;
        setPositions(prev => {
          const existingIds = new Set(prev.map(p => p.id));
          // Merge prices for existing positions; append brand-new ones
          const merged = mergeServerPrices(prev, data.positions);
          const newPositions = data.positions.filter(fp => !existingIds.has(fp.id));
          return [...merged, ...newPositions];
        });
      })
      .catch(() => {});
  }, [mergeServerPrices]);

  const handleDismissEntry = useCallback(async (id) => {
    await dismissPendingEntry(id);
    setPendingEntries(prev => prev.filter(e => e.id !== id));
  }, []);

  const tabs = [
    { id: 'positions',  l: 'Positions & Orders' },
    { id: 'pipeline',   l: 'Kill Pipeline' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', color: '#e8e6e3', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* Header */}
      <div style={{ padding: '12px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 17, fontWeight: 800 }}>
            <span style={{ color: '#FFD700' }}>PNTHR</span> <span style={{ color: '#555' }}>COMMAND</span>
          </span>
          <div style={{ height: 18, width: 1, background: 'rgba(255,255,255,0.08)' }} />
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ background: tab === t.id ? 'rgba(255,215,0,0.08)' : 'none',
                border: tab === t.id ? '1px solid rgba(255,215,0,0.2)' : '1px solid transparent',
                color: tab === t.id ? '#FFD700' : '#666', fontSize: 12, fontWeight: 600,
                padding: '5px 12px', borderRadius: 5, cursor: 'pointer' }}>
              {t.l}
            </button>
          ))}
          {saving && <span style={{ fontSize: 10, color: '#555' }}>saving…</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: 4,
              background: heat.totalRiskPct > 15 ? '#dc3545' : heat.totalRiskPct > 10 ? '#ffc107' : '#28a745' }} />
            <span style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
              {heat.stockRiskPct}% stocks · {heat.etfRiskPct}% ETFs · {heat.totalRiskPct}% total
            </span>
          </div>
          {/* IBKR sync indicator — visible when any position has been synced from TWS */}
          {(() => {
            const ibkrTs = positions.find(p => p.ibkrSyncedAt)?.ibkrSyncedAt;
            if (!ibkrTs) return null;
            const secsAgo = Math.round((Date.now() - new Date(ibkrTs).getTime()) / 1000);
            const fresh   = secsAgo < 300;
            const label   = secsAgo < 60 ? `${secsAgo}s ago` : `${Math.floor(secsAgo / 60)}m ago`;
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: fresh ? '#28a745' : '#888', fontSize: 10 }}>● IBKR</span>
                <span style={{ color: '#555', fontSize: 10, fontFamily: 'monospace' }}>{label}</span>
              </div>
            );
          })()}
          {/* Refresh controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: 3,
              background: isMarketHours() ? '#28a745' : '#555',
              boxShadow: isMarketHours() ? '0 0 5px #28a745' : 'none' }} />
            <span style={{ fontSize: 10, color: isMarketHours() ? '#28a745' : '#555' }}>
              {isMarketHours() ? 'LIVE' : 'CLOSED'}
            </span>
            <button onClick={refreshPrices} disabled={refreshing}
              title="Refresh prices"
              style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4,
                color: refreshing ? '#555' : '#888', cursor: refreshing ? 'not-allowed' : 'pointer',
                fontSize: 13, padding: '2px 7px', lineHeight: 1,
                transition: 'color 0.2s' }}>
              {refreshing ? '⟳' : '↻'}
            </button>
            {lastRefresh && (
              <span style={{ fontSize: 10, color: '#444', fontFamily: 'monospace' }}>
                {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </div>
          <span style={{ fontSize: 11, color: '#555' }}>NAV</span>
          <input type="number" value={nav} onChange={e => handleNavChange(+e.target.value || 0)}
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6, padding: '5px 10px', color: '#FFD700', fontSize: 13, fontFamily: 'monospace',
              width: 120, textAlign: 'right', outline: 'none', fontWeight: 700 }} />
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>
        {tab === 'positions' && (
          <div>
            {/* Pending Entries — queued from Kill page, awaiting fill confirmation */}
            {pendingEntries.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#FFD700', letterSpacing: '0.1em',
                  textTransform: 'uppercase', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  ⏳ PENDING ENTRIES
                  <span style={{ fontSize: 10, background: 'rgba(255,215,0,0.15)', color: '#FFD700',
                    padding: '2px 7px', borderRadius: 4, fontWeight: 700 }}>
                    {pendingEntries.length}
                  </span>
                  <span style={{ fontSize: 10, color: '#555', fontWeight: 400, fontStyle: 'italic' }}>
                    — Enter actual fill price &amp; shares, then CONFIRM ENTRY
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[...pendingEntries]
                    .sort((a, b) => {
                      const aExp = Date.now() - new Date(a.queuedAt).getTime() > FIVE_DAYS_MS;
                      const bExp = Date.now() - new Date(b.queuedAt).getTime() > FIVE_DAYS_MS;
                      if (aExp && !bExp) return 1;
                      if (!aExp && bExp) return -1;
                      return new Date(a.queuedAt) - new Date(b.queuedAt);
                    })
                    .map(entry => (
                      <PendingCard key={entry.id} entry={entry} nav={nav}
                        onConfirm={handleConfirmEntry} onDismiss={handleDismissEntry} />
                    ))}
                </div>
              </div>
            )}

          {/* Sector concentration warning banner */}
            {sectorWarning && (
              <div style={{ background: 'rgba(255,193,7,0.1)', border: '1px solid rgba(255,193,7,0.3)',
                borderRadius: 8, padding: '10px 16px', marginBottom: 14,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 12, color: '#ffc107', fontWeight: 600 }}>
                <span>⚠ SECTOR CONCENTRATION: {sectorWarning}</span>
                <button onClick={() => setSectorWarning(null)}
                  style={{ background: 'none', border: 'none', color: '#ffc107', cursor: 'pointer',
                    fontSize: 18, lineHeight: 1, padding: '0 4px' }}>×</button>
              </div>
            )}
            {/* Metric cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 16 }}>
              <MC label="Net liquidity" value={`$${(nav / 1000).toFixed(0)}K`} />
              <MC label="Stock risk"
                value={`$${heat.stockRisk.toLocaleString()}`}
                sub={`${heat.stockRiskPct}% of NAV`}
                sub2="Cap: 10%"
                accent={heat.stockRiskPct > 10 ? '#dc3545' : heat.stockRiskPct > 8 ? '#ffc107' : '#28a745'} />
              <MC label="ETF risk"
                value={`$${heat.etfRisk.toLocaleString()}`}
                sub={`${heat.etfRiskPct}% of NAV`}
                sub2="Cap: 5%"
                accent={heat.etfRiskPct > 5 ? '#dc3545' : heat.etfRiskPct > 4 ? '#ffc107' : '#28a745'} />
              <MC label="Total risk"
                value={`$${heat.totalRisk.toLocaleString()}`}
                sub={`${heat.totalRiskPct}% of NAV`}
                sub2="Cap: 15%"
                accent={heat.totalRiskPct > 15 ? '#dc3545' : heat.totalRiskPct > 12 ? '#ffc107' : '#28a745'} />
              <MC label="Recycled" value={heat.recycledCnt} sub="$0 risk" accent="#28a745" />
              <MC label="Total positions" value={heat.totalPos} sub={`${heat.liveCnt} live · ${heat.recycledCnt} recycled`} />
            </div>

            {/* Risk Advisor — runs every time positions load */}
            {!loading && <RiskAdvisor recommendations={advisorRecs} />}

            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#555' }}>Loading positions…</div>
            ) : positions.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#555', fontSize: 13 }}>
                No active positions. Open a chart on the <span style={{ color: '#FFD700' }}>PNTHR Kill</span> page, click <span style={{ color: '#FFD700' }}>SIZE IT</span>, and queue setups to send here.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {positions.map(p => (
                  <PyramidCard key={p.id} position={p} netLiquidity={nav}
                    onUpdate={updateFills} onUpdateStop={updateStop} onUpdatePrice={updatePrice}
                    onClearOverride={clearOverride}
                    onDelete={handleDeletePosition}
                    onExitConfirmed={async (exitResult) => {
                      // Fetch fresh positions — server excludes CLOSED ones from this query.
                      const data = await apiGet('/api/positions').catch(() => null);
                      const freshPositions = data?.positions || [];

                      if (exitResult?.status === 'CLOSED') {
                        // Full exit: remove this position from Command view, show toast.
                        // p.id + avgCostOf(p) captured from the map closure.
                        const avg = avgCostOf(p);
                        setPositions(prev => prev.filter(x => x.id !== p.id));
                        setClosedToast({
                          ticker:     p.ticker,
                          avgCost:    avg,
                          exitPrice:  exitResult.exitRecord?.price,
                          pnlDollar:  exitResult.exitRecord?.pnl?.dollar,
                          pnlPct:     exitResult.exitRecord?.pnl?.pct,
                        });
                        setTimeout(() => setClosedToast(null), 10000);
                      } else {
                        // Partial exit: merge updated fields (remainingShares, exits, P&L)
                        // but preserve sacred user-edited fields (fills, stops, etc.)
                        if (freshPositions.length) {
                          setPositions(prev => mergeAfterExit(prev, freshPositions));
                        }
                      }
                    }}
                    flashed={flashedTickers.has(p.ticker)}
                    onOpenChart={(clicked) => {
                      const stocks = positions.map(pos => ({
                        ticker: pos.ticker, symbol: pos.ticker,
                        currentPrice: pos.currentPrice, signal: pos.signal,
                        sector: pos.sector, stopPrice: pos.stopPrice,
                      }));
                      const index = stocks.findIndex(s => s.ticker === clicked.ticker);
                      setChartModal({ stocks, index: Math.max(0, index) });
                    }} />
                ))}
              </div>
            )}
          </div>
        )}
        {tab === 'pipeline'   && <PipelineTab positions={positions} nav={nav} />}
      </div>

      {/* Chart Modal — opens when a position ticker is clicked; cycles through all positions */}
      {chartModal && (
        <ChartModal
          stocks={chartModal.stocks}
          initialIndex={chartModal.index}
          earnings={{}}
          onClose={() => setChartModal(null)}
        />
      )}

      {/* Closed position toast — shown after a full exit, auto-dismisses in 10s */}
      {closedToast && (() => {
        const { ticker, avgCost, exitPrice, pnlDollar, pnlPct } = closedToast;
        const isGain = (pnlDollar ?? 0) >= 0;
        const pnlColor = isGain ? '#28a745' : '#dc3545';
        return (
          <div style={{
            position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
            zIndex: 300, background: '#1a1a1a', border: `1px solid ${pnlColor}`,
            borderRadius: 10, padding: '14px 20px', minWidth: 280, maxWidth: 380,
            boxShadow: `0 4px 24px rgba(0,0,0,0.6), 0 0 0 1px ${pnlColor}22`,
          }}>
            <button onClick={() => setClosedToast(null)} style={{
              position: 'absolute', top: 8, right: 10, background: 'none', border: 'none',
              color: '#555', cursor: 'pointer', fontSize: 14, lineHeight: 1,
            }}>✕</button>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>✓ Position closed</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>{ticker}</div>
            {avgCost != null && exitPrice != null && (
              <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4, fontFamily: 'monospace' }}>
                Avg cost ${avgCost.toFixed(2)} → Exit ${Number(exitPrice).toFixed(2)}
              </div>
            )}
            {pnlDollar != null && (
              <div style={{ fontSize: 14, fontWeight: 700, color: pnlColor, marginBottom: 10 }}>
                P&L: {isGain ? '+' : ''}${pnlDollar.toFixed(2)}
                {pnlPct != null && <span style={{ fontSize: 12, marginLeft: 6 }}>({isGain ? '+' : ''}{pnlPct.toFixed(1)}%)</span>}
              </div>
            )}
            <div style={{ fontSize: 11, color: '#555', marginBottom: onNavigate ? 8 : 0 }}>Moved to PNTHR Journal</div>
            {onNavigate && (
              <button onClick={() => { setClosedToast(null); onNavigate('journal'); }}
                style={{ background: 'none', border: '1px solid #444', borderRadius: 4, color: '#FFD700',
                  fontSize: 11, fontWeight: 700, padding: '4px 10px', cursor: 'pointer', letterSpacing: '0.05em' }}>
                VIEW IN JOURNAL →
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
}
