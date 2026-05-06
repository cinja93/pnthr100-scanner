// client/src/components/pyramid/index.jsx
// Extracted from CommandCenter.jsx — pyramid position card, exit panel,
// delete + close-via-bridge buttons, and shared helpers.
//
// Imported by AssistantRowExpand (and CommandCenter while it still exists).

import { useState, Fragment } from 'react';
import { API_BASE, authHeaders } from '../../services/api.js';
import { STRIKE_PCT, buildLots, enrichLots, sizePosition } from '../../utils/sizingUtils.js';

export function getDisplayPrice(p) {
  const ov = p.manualPriceOverride;
  if (!ov?.active) return p.currentPrice ?? 0;
  return ov.price; // always use override while active; cleared by ✕ or when FMP catches up
}

export function highestFilledLot(p) {
  let high = 0;
  for (let i = 1; i <= 5; i++) if (p.fills?.[i]?.filled) high = i;
  return high;
}

export function filledSharesOf(p) {
  let total = 0;
  for (let i = 1; i <= 5; i++) {
    const f = p.fills?.[i];
    if (f?.filled) total += +(f.shares ?? 0);
  }
  return total;
}

export function avgCostOf(p) {
  if (p.manualAvgCost) return +p.manualAvgCost;
  let cost = 0, shares = 0;
  for (let i = 1; i <= 5; i++) {
    const f = p.fills?.[i];
    if (f?.filled && f?.price && f?.shares) { cost += +f.shares * +f.price; shares += +f.shares; }
  }
  return shares > 0 ? cost / shares : (p.entryPrice || 0);
}

export function pnlPctOf(p) {
  const avg = avgCostOf(p);
  if (!avg || !p.currentPrice) return 0;
  const raw = (p.currentPrice - avg) / avg * 100;
  return p.direction === 'SHORT' ? -raw : raw;
}

export function isRecycledPos(p) {
  const avg = avgCostOf(p);
  return p.direction === 'LONG' ? p.stopPrice >= avg : p.stopPrice <= avg;
}

// dollarAtRisk — mirrors PyramidCard actualRisk calculation; used for default sort
export function dollarAtRisk(p) {
  const avg = avgCostOf(p);
  const shares = filledSharesOf(p);
  if (!p.stopPrice || shares <= 0) return 0;
  const isRecycled = p.direction === 'LONG' ? p.stopPrice >= avg : p.stopPrice <= avg;
  if (isRecycled) return 0;
  const riskPerShr = p.direction === 'LONG'
    ? Math.max(avg - p.stopPrice, 0)
    : Math.max(p.stopPrice - avg, 0);
  return shares * riskPerShr;
}

export function Badge({ children, color = '#888', bg, small }) {
  return (
    <span style={{ display: 'inline-block', padding: small ? '1px 6px' : '2px 8px', borderRadius: 4,
      fontSize: small ? 10 : 11, fontWeight: 600, color, background: bg || 'rgba(255,255,255,0.06)',
      textTransform: 'uppercase', whiteSpace: 'nowrap', lineHeight: '18px', letterSpacing: '0.02em' }}>
      {children}
    </span>
  );
}
export function SigBadge({ d }) {
  return d === 'LONG'
    ? <Badge color="#0f5132" bg="#d1e7dd">LONG</Badge>
    : <Badge color="#842029" bg="#f8d7da">SHORT</Badge>;
}
export function TierBadge({ t }) {
  const map = { 'ALPHA PNTHR KILL': '#FFD700', 'STRIKING': '#FF8C00', 'HUNTING': '#4A90D9', 'POUNCING': '#5B8C5A' };
  const bg  = map[t] || '#555';
  return <Badge color={['ALPHA PNTHR KILL','STRIKING'].includes(t) ? '#000' : '#fff'} bg={bg}>{t}</Badge>;
}
export function MC({ label, value, sub, sub2, accent }) {
  const valLen = typeof value === 'string' ? value.length : 0;
  const valSize = valLen > 14 ? 15 : valLen > 10 ? 18 : 22;
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '12px 14px',
      border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 10, color: '#777', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: valSize, fontWeight: 700, color: accent || '#e8e6e3', marginTop: 2, fontFamily: 'monospace' }}>{value}</div>
      {sub  && <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>{sub}</div>}
      {sub2 && <div style={{ fontSize: 10, color: '#888', marginTop: 1 }}>{sub2}</div>}
    </div>
  );
}
export const fI = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4, padding: '4px 6px', color: '#FFD700', fontSize: 12,
  fontFamily: 'monospace', outline: 'none', textAlign: 'right',
};

// ── API Helpers ───────────────────────────────────────────────────────────────

export async function apiGet(path) {
  const res = await fetch(`${API_BASE || ''}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function apiPost(path, body) {
  const res = await fetch(`${API_BASE || ''}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
export function ExitPanel({ position, onClose, onConfirm }) {
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
    { value: 'SIGNAL',       label: 'SIGNAL — PNTHR exit signal (BE/SE) fired' },
    { value: 'FEAST',        label: 'FEAST — RSI extreme, selling per FEAST rule' },
    { value: 'STOP_HIT',     label: 'STOP_HIT — Stop price was hit' },
    { value: 'STALE_HUNT',   label: 'STALE_HUNT — 20-day timer expired' },
    { value: 'RISK_ADVISOR', label: 'RISK ADVISOR — Sector/heat risk management' },
    { value: 'MANUAL',       label: 'MANUAL — Discretionary override ⚠' },
  ];

  const sharesNum   = parseFloat(shares) || 0;
  const priceNum    = parseFloat(price)  || 0;
  const isManual    = reason === 'MANUAL';
  const isRiskAdvisor = reason === 'RISK_ADVISOR';
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
        <label style={{ ...labelSt, color: isManual ? '#dc3545' : isRiskAdvisor ? '#dc3545' : '#888' }}>
          {isManual ? '⚠ REQUIRED — EXPLAIN YOUR OVERRIDE' : isRiskAdvisor ? 'RISK ADVISOR NOTE (optional)' : 'NOTE (optional)'}
        </label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          placeholder={isManual ? 'What are you seeing? Why are you overriding the system?' : isRiskAdvisor ? 'Sector concentration context (auto-filled if opened from Risk Advisor)' : 'What are you seeing? (optional)'}
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

// Day 1 (2026-04-29): exported as a named export so AssistantRowExpand can
// reuse the full editable lot card without copy-pasting 815 lines. Day 2
// cleanup will move PyramidCard to its own file when CommandCenter.jsx is
export function PyramidCard({ position, netLiquidity, onUpdate, onUpdateStop, onUpdatePrice, onClearOverride, onDelete, onExitConfirmed, flashed, onOpenChart, onField, onDirectionChange }) {
  const [expanded,      setExpanded]      = useState(false);
  const [editing,       setEditing]       = useState(null);
  const [ev,            setEv]            = useState({});
  const [editingStop,   setEditingStop]   = useState(false);
  const [editDirection, setEditDirection] = useState(position.direction || 'LONG');
  const [stopVal,       setStopVal]       = useState('');
  const [twsAvg,        setTwsAvg]        = useState('');
  const [ratchetRec,    setRatchetRec]    = useState(null);
  const [ratchetModal,  setRatchetModal]  = useState(null); // { n, updates, ratchetLevel }
  const [exitPanelOpen, setExitPanelOpen] = useState(false);
  const [localPrice,    setLocalPrice]    = useState(null); // null = not actively editing
  const [editingAvgCost, setEditingAvgCost] = useState(false);
  const [avgCostInput,   setAvgCostInput]   = useState('');

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
  const avg     = position.manualAvgCost ? +position.manualAvgCost : (totShr > 0 ? totCost / totShr : position.entryPrice);

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
    const updates = { fills: nf };
    if (n === 1 && editDirection !== position.direction) {
      updates.direction = editDirection;
      updates.signal    = editDirection === 'LONG' ? 'BL' : 'SS';
    }

    // Lots 2+: show ratchet confirmation modal before saving
    if (n >= 2) {
      // Ratchet levels: Lot 3 → Lot 1 fill, Lot 4 → Lot 2 fill, Lot 5 → Lot 3 fill
      const ratchetLevel = n === 3 ? (lots[0]?.actualPrice || null)
                         : n === 4 ? (lots[1]?.actualPrice || null)
                         : n === 5 ? (lots[2]?.actualPrice || null)
                         : null;
      setRatchetModal({ n, updates, ratchetLevel: ratchetLevel ? +ratchetLevel : null });
      return; // wait for modal confirmation
    }

    // Lot 1: save immediately (no ratchet)
    onUpdate(position.id, updates);
    if (n === 1 && editingStop) { const v = parseFloat(stopVal); if (v) onUpdateStop(position.id, v); }
    setEditing(null); setEditingStop(false); setTwsAvg('');
  };

  const commitFill = (withRatchet) => {
    if (!ratchetModal) return;
    onUpdate(position.id, ratchetModal.updates);
    if (withRatchet && ratchetModal.ratchetLevel) {
      const isLongDir = position.direction === 'LONG';
      const protectedStop = isLongDir
        ? Math.max(ratchetModal.ratchetLevel, position.stopPrice)
        : Math.min(ratchetModal.ratchetLevel, position.stopPrice);
      if (protectedStop !== position.stopPrice) {
        onUpdateStop(position.id, protectedStop);
      }
    }
    setRatchetModal(null);
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
          {onDirectionChange ? (
            <span
              onClick={() => {
                const newDir = position.direction === 'LONG' ? 'SHORT' : 'LONG';
                if (window.confirm(`Change ${position.ticker} from ${position.direction} to ${newDir}?`)) {
                  onDirectionChange(position.id, newDir);
                }
              }}
              title="Click to correct direction (LONG ⇄ SHORT)"
              style={{ cursor: 'pointer' }}>
              <SigBadge d={position.direction} />
              <span style={{ fontSize: 9, color: '#444', marginLeft: 2 }}>⇄</span>
            </span>
          ) : (
            <SigBadge d={position.direction} />
          )}
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
                {editingAvgCost ? (
                  <>
                    <input
                      type="number" step="0.01"
                      value={avgCostInput}
                      onChange={e => setAvgCostInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const v = parseFloat(avgCostInput);
                          if (v > 0) { onField(position.id, { manualAvgCost: v }); }
                          setEditingAvgCost(false);
                        }
                        if (e.key === 'Escape') setEditingAvgCost(false);
                      }}
                      autoFocus
                      style={{ width: 72, fontSize: 11, background: '#222', border: '1px solid #FFD700', color: '#FFD700', borderRadius: 3, padding: '1px 4px', fontFamily: 'monospace' }}
                    />
                    <button onClick={() => { const v = parseFloat(avgCostInput); if (v > 0) { onField(position.id, { manualAvgCost: v }); } setEditingAvgCost(false); }}
                      style={{ marginLeft: 4, fontSize: 10, background: '#FFD700', color: '#000', border: 'none', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', fontWeight: 700 }}>✓</button>
                    <button onClick={() => setEditingAvgCost(false)}
                      style={{ marginLeft: 2, fontSize: 10, background: '#333', color: '#aaa', border: 'none', borderRadius: 3, padding: '1px 6px', cursor: 'pointer' }}>✕</button>
                  </>
                ) : (
                  <>
                    <b style={{ color: '#FFD700' }}>${avg.toFixed(2)}</b>
                    <span style={{ color: '#555', fontWeight: 400 }}> ({totShr} shr)</span>
                    {position.manualAvgCost && (
                      <span style={{ color: '#6ea8fe', marginLeft: 4, fontSize: 10, fontWeight: 400 }}>
                        IBKR override
                        <button onClick={() => onField(position.id, { manualAvgCost: null })}
                          style={{ marginLeft: 3, fontSize: 9, background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: 0 }}>×</button>
                      </span>
                    )}
                    <button onClick={() => { setAvgCostInput(avg.toFixed(2)); setEditingAvgCost(true); }}
                      style={{ marginLeft: 5, fontSize: 9, background: 'none', border: '1px solid #333', color: '#555', borderRadius: 3, padding: '0 4px', cursor: 'pointer', lineHeight: '14px' }}
                      title="Override avg cost (e.g. match IBKR)">✎</button>
                  </>
                )}
                {!editingAvgCost && position.ibkrAvgCost && !position.manualAvgCost && (() => {
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
                      ) : (() => {
                        // 3B: Never show a stop value that's LESS protective than current stop
                        const rawRec = l.recommendedStop;
                        const protectedStop = isLong
                          ? Math.max(rawRec, position.stopPrice)
                          : Math.min(rawRec, position.stopPrice);
                        const alreadyProtected = rawRec !== position.stopPrice && protectedStop === position.stopPrice;
                        return alreadyProtected
                          ? <span style={{ fontSize: 10, color: '#28a745' }}>✓ ${position.stopPrice}</span>
                          : <span style={{ fontSize: 11, color: '#666' }}>${protectedStop}</span>;
                      })()}
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
          {/* Ratchet confirmation modal — shown before saving Lot 2+ fills */}
          {ratchetModal && (() => {
            const { n, ratchetLevel } = ratchetModal;
            const isLong = position.direction === 'LONG';
            const curStop = position.stopPrice;
            const isLot2 = n === 2;
            const alreadyProtected = ratchetLevel && (isLong ? curStop >= ratchetLevel : curStop <= ratchetLevel);
            const needsRatchet = !isLot2 && ratchetLevel && !alreadyProtected;
            const protectedStop = needsRatchet
              ? (isLong ? Math.max(ratchetLevel, curStop) : Math.min(ratchetLevel, curStop))
              : null;
            return (
              <div style={{ margin: '0 18px 8px', padding: '14px 16px',
                background: '#1a1a1a', border: '2px solid rgba(255,193,7,0.5)',
                borderRadius: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#FFD700', marginBottom: 8, letterSpacing: '0.06em' }}>
                  ⚡ LOT {n} FILL — STOP CHECK
                </div>
                {isLot2 && (
                  <>
                    <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
                      Current stop: <b style={{ color: '#dc3545' }}>${curStop}</b>
                      <span style={{ color: '#555', marginLeft: 8 }}>· No ratchet required at Lot 2</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#666', marginBottom: 12 }}>
                      Next ratchet at Lot 3 → move stop to Lot 1 fill price (breakeven).
                    </div>
                    <button onClick={() => commitFill(false)}
                      style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 4, padding: '5px 16px', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
                      CONFIRM FILL ✓
                    </button>
                  </>
                )}
                {!isLot2 && alreadyProtected && (
                  <>
                    <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
                      Current stop: <b style={{ color: '#28a745' }}>${curStop}</b>
                      {ratchetLevel && <span style={{ color: '#28a745', marginLeft: 8 }}>✓ Already protected (≥ Lot {n-2} fill ${ratchetLevel})</span>}
                    </div>
                    <button onClick={() => commitFill(false)}
                      style={{ background: '#28a745', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 16px', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
                      CONFIRM FILL ✓
                    </button>
                  </>
                )}
                {needsRatchet && (
                  <>
                    <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
                      Current stop: <b style={{ color: '#dc3545' }}>${curStop}</b>
                      <span style={{ color: '#ffc107', marginLeft: 8 }}>→ Recommended: ${protectedStop} (Lot {n-2} fill)</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button onClick={() => commitFill(true)}
                        style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 4, padding: '5px 16px', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
                        FILL + RATCHET STOP → ${protectedStop}
                      </button>
                      <button onClick={() => commitFill(false)}
                        style={{ background: 'rgba(255,255,255,0.08)', color: '#aaa', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '5px 12px', fontSize: 11, cursor: 'pointer' }}>
                        Fill without ratchet
                      </button>
                      <button onClick={() => setRatchetModal(null)}
                        style={{ background: 'none', color: '#666', border: 'none', fontSize: 12, cursor: 'pointer', marginLeft: 4 }}>
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

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

          {/* EXIT SHARES + CLOSE VIA TWS buttons (Phase 4f) */}
          {(position.remainingShares == null || position.remainingShares > 0) && (
            <div style={{ margin: '0 18px 8px', display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => setExitPanelOpen(p => !p)}
                style={{ background: 'transparent', border: '1px solid #FFD700', color: '#FFD700', borderRadius: 6, padding: '5px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}
                title="Journal an exit you already executed in TWS. Does NOT place a sell order."
              >
                {exitPanelOpen ? '✕ CANCEL' : '+ JOURNAL EXIT'}
              </button>
              <CloseViaBridgeButton
                position={position}
                onClosed={onExitConfirmed}
              />
            </div>
          )}
          {position.sellPending && (
            <div style={{ margin: '0 18px 8px', padding: '8px 12px', background: 'rgba(252,240,0,0.06)', border: '1px solid rgba(252,240,0,0.25)', borderRadius: 4, fontSize: 11, color: '#fcf000' }}>
              ⏳ Sell order queued in bridge ({position.sellPending.orderType}{position.sellPending.orderType === 'LMT' ? ` @ $${(+position.sellPending.limitPrice).toFixed(2)}` : ''}). Position closes once the fill arrives via Phase 2 sync.
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

export function DeleteBtn({ onDelete }) {
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

// ── Close Via Bridge button (Phase 4f) ────────────────────────────────────
// Places a real TWS sell order via the IBKR outbox bridge. Click → confirm
// → enqueue. The actual close (status flip, journal entry, P&L) happens
// asynchronously when Phase 2 sees the SLD execution in the next bridge sync,
// so the journal price equals the real fill price by construction.
//
// During RTH this defaults to a market order. Outside RTH the user must
// supply a limit price (IBKR rejects MKT outside RTH). The check uses the
// browser clock — close enough for UX purposes; the bridge enforces RTH on
// the order itself.
export function CloseViaBridgeButton({ position, onClosed }) {
  const [stage, setStage] = useState('idle'); // idle | confirm | submitting | error
  const [orderType, setOrderType] = useState('MKT');
  const [limitPrice, setLimitPrice] = useState('');
  const [errorMsg, setErrorMsg] = useState(null);

  const isRTH = (() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false;
    const m = et.getHours() * 60 + et.getMinutes();
    return m >= 570 && m <= 960; // 9:30–16:00 ET
  })();

  if (position.sellPending) return null; // already queued, don't show button

  if (stage === 'idle') {
    return (
      <button
        onClick={() => {
          setStage('confirm');
          setOrderType(isRTH ? 'MKT' : 'LMT');
          setLimitPrice(isRTH ? '' : (position.currentPrice ? (+position.currentPrice).toFixed(2) : ''));
        }}
        style={{ background: '#0a3a1a', border: '1px solid #86efac', color: '#86efac', borderRadius: 6, padding: '5px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}
        title={isRTH ? 'Place a market sell in TWS to close this position. Journal records the actual fill price.' : 'Outside RTH — IBKR requires LMT. You\'ll be prompted for a limit price.'}
      >
        🔴 CLOSE VIA TWS
      </button>
    );
  }

  if (stage === 'confirm') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: '6px 10px', background: 'rgba(0,0,0,0.3)',
        border: '1px solid rgba(134,239,172,0.4)', borderRadius: 6,
      }}>
        <span style={{ fontSize: 11, color: '#86efac', fontWeight: 700 }}>
          Sell {position.ticker}
        </span>
        <select
          value={orderType}
          onChange={e => setOrderType(e.target.value)}
          disabled={!isRTH}
          style={{ background: '#1a1a1a', color: '#86efac', border: '1px solid rgba(134,239,172,0.4)', borderRadius: 4, padding: '3px 6px', fontSize: 11 }}
        >
          {isRTH && <option value="MKT">MKT</option>}
          <option value="LMT">LMT</option>
        </select>
        {orderType === 'LMT' && (
          <>
            <span style={{ fontSize: 11, color: '#888' }}>@</span>
            <input
              type="number"
              step="0.01"
              value={limitPrice}
              onChange={e => setLimitPrice(e.target.value)}
              placeholder="0.00"
              style={{ background: '#1a1a1a', color: '#86efac', border: '1px solid rgba(134,239,172,0.4)', borderRadius: 4, padding: '3px 6px', fontSize: 11, width: 80 }}
            />
          </>
        )}
        {!isRTH && orderType === 'LMT' && (
          <span style={{ fontSize: 9, color: '#fcf000' }}>(EXT-HRS)</span>
        )}
        <button
          onClick={async () => {
            if (orderType === 'LMT' && (!limitPrice || +limitPrice <= 0)) {
              setErrorMsg('Limit price required');
              return;
            }
            setStage('submitting');
            setErrorMsg(null);
            try {
              const r = await fetch(`${API_BASE}/api/positions/close-via-bridge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                  id: position.id,
                  orderType,
                  limitPrice: orderType === 'LMT' ? +limitPrice : null,
                }),
              });
              const data = await r.json();
              if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
              setStage('idle');
              onClosed?.({ pending: true, message: data.message });
            } catch (e) {
              setErrorMsg(e.message);
              setStage('error');
            }
          }}
          style={{ background: '#0a3a1a', border: '1px solid #86efac', color: '#86efac', borderRadius: 4, padding: '3px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
        >
          PLACE SELL
        </button>
        <button
          onClick={() => { setStage('idle'); setErrorMsg(null); }}
          style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: '#888', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer' }}
        >
          CANCEL
        </button>
      </div>
    );
  }

  if (stage === 'submitting') {
    return (
      <span style={{ fontSize: 11, color: '#86efac', padding: '5px 16px' }}>
        Queueing sell…
      </span>
    );
  }

  if (stage === 'error') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', background: 'rgba(220,53,69,0.1)',
        border: '1px solid rgba(220,53,69,0.4)', borderRadius: 6,
      }}>
        <span style={{ fontSize: 11, color: '#fca5a5' }}>{errorMsg}</span>
        <button
          onClick={() => { setStage('idle'); setErrorMsg(null); }}
          style={{ background: 'transparent', border: '1px solid rgba(220,53,69,0.4)', color: '#fca5a5', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer' }}
        >
          DISMISS
        </button>
      </div>
    );
  }

  return null;
}

// ── Pending Entry Card ────────────────────────────────────────────────────────

