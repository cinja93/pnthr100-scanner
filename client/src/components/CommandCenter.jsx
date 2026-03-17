// client/src/components/CommandCenter.jsx
// ── PNTHR Command Center — Portfolio Management Dashboard ─────────────────────
//
// Tier A pyramiding: 15-30-25-20-10 · Editable fills, stops, prices
// Live position data from /api/positions + kill signals from /api/kill-pipeline
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { API_BASE, authHeaders, updateUserProfile } from '../services/api.js';
import { useAuth } from '../AuthContext';

// ── Sizing Constants ──────────────────────────────────────────────────────────

const STRIKE_PCT    = [0.15, 0.30, 0.25, 0.20, 0.10];
const LOT_NAMES     = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
const LOT_OFFSETS   = [0, 0.03, 0.06, 0.10, 0.14];
const LOT_TIME_GATES = [0, 5, 0, 0, 0];

// ── Position Sizing Logic ─────────────────────────────────────────────────────

function buildLots({ entryPrice, stopPrice, totalShares, direction, fills = {} }) {
  const isLong = direction === 'LONG';
  const anchor = fills[1]?.filled && fills[1]?.price ? +fills[1].price : entryPrice;
  return STRIKE_PCT.map((pct, i) => {
    const targetShares  = Math.max(1, Math.round(totalShares * pct));
    const triggerPrice  = isLong ? +(anchor * (1 + LOT_OFFSETS[i])).toFixed(2) : +(anchor * (1 - LOT_OFFSETS[i])).toFixed(2);
    const fill          = fills[i + 1] || {};
    const filled        = fill.filled || false;
    const actualPrice   = fill.price  != null ? +fill.price  : null;
    const actualShares  = fill.shares != null ? +fill.shares : (filled ? targetShares : 0);
    const actualDate    = fill.date   || null;
    const costBasis     = filled && actualPrice ? +(actualShares * actualPrice).toFixed(2) : 0;
    return { lot: i + 1, name: LOT_NAMES[i], pctLabel: STRIKE_PCT[i] * 100, targetShares, triggerPrice,
             offsetPct: Math.round(LOT_OFFSETS[i] * 100), timeGate: LOT_TIME_GATES[i],
             filled, actualPrice, actualShares, actualDate, costBasis, anchor };
  });
}

function enrichLots(lots, entryPrice, stopPrice, direction) {
  const isLong = direction === 'LONG';
  let cumShr = 0, cumCost = 0;
  return lots.map((l, i) => {
    if (l.filled && l.actualShares > 0) { cumShr += l.actualShares; cumCost += l.costBasis; }
    const avgCost = cumShr > 0 ? +(cumCost / cumShr).toFixed(2) : 0;
    let recStop, rNote;
    if (i <= 1) { recStop = stopPrice; rNote = null; }
    else if (i === 2) {
      const p = lots[0].actualPrice || entryPrice; recStop = +p.toFixed(2);
      rNote = `Move stop → $${recStop} (Lot 1 fill = breakeven)`;
    } else if (i === 3) {
      const p = lots[1].actualPrice || lots[1].triggerPrice; recStop = +p.toFixed(2);
      rNote = `Ratchet stop → $${recStop} (Lot 2 fill)`;
    } else {
      const p = lots[2].actualPrice || lots[2].triggerPrice; recStop = +p.toFixed(2);
      rNote = `Ratchet stop → $${recStop} (Lot 3 fill)`;
    }
    return { ...l, cumShr, cumCost: +cumCost.toFixed(2), avgCost, recommendedStop: recStop, ratchetNote: rNote };
  });
}

function sizePosition({ netLiquidity, entryPrice, stopPrice, maxGapPct, direction }) {
  const tickerCap = netLiquidity * 0.10;
  const vitality  = netLiquidity * 0.01;
  const structRisk = Math.abs((entryPrice - stopPrice) / entryPrice);
  const gapMult   = maxGapPct > structRisk * 100 ? Math.max(0.3, structRisk * 100 / maxGapPct) : 1.0;
  const rps       = Math.abs(entryPrice - stopPrice);
  const total     = Math.floor(
    Math.min(rps > 0 ? Math.floor(vitality / rps) : 0, Math.floor(tickerCap / entryPrice)) * gapMult
  );
  return { totalShares: total, gapMult: +gapMult.toFixed(2), structRisk: +(structRisk * 100).toFixed(2),
           maxRisk$: +(total * rps).toFixed(2), gapProne: maxGapPct > structRisk * 100 };
}

function calcHeat(positions, nav) {
  let liveCnt = 0, recycledCnt = 0, actual$ = 0;
  for (const p of positions) {
    const filledShr = Object.values(p.fills || {}).reduce((s, f) => s + (f.filled ? (+f.shares || 0) : 0), 0);
    const lot1P     = p.fills?.[1]?.price ? +p.fills[1].price : p.entryPrice;
    const isL       = p.direction === 'LONG';
    const rps       = isL ? Math.max(lot1P - p.stopPrice, 0) : Math.max(p.stopPrice - lot1P, 0);
    const posRisk   = filledShr * rps;
    const isRecycled = isL ? p.stopPrice >= lot1P : p.stopPrice <= lot1P;
    if (isRecycled) { recycledCnt++; } else { liveCnt++; actual$ += posRisk; }
  }
  const theo$ = liveCnt * nav * 0.01;
  return {
    liveCnt, recycledCnt, totalPos: positions.length,
    theo$: +theo$.toFixed(0), theoPct: +((theo$ / nav) * 100).toFixed(1),
    actual$: +actual$.toFixed(0), actualPct: +((actual$ / nav) * 100).toFixed(2),
    slots: Math.max(0, Math.floor((nav * 0.10 - theo$) / (nav * 0.01))),
  };
}

// ── Risk Advisor Helpers ──────────────────────────────────────────────────────

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

  // Rule 1: Heat Cap Violation (>10 live positions = >10% heat)
  if (liveCnt > 10) {
    const excess = liveCnt - 10;
    const candidates = [...livePos].sort((a, b) => pnlPctOf(a) - pnlPctOf(b)).slice(0, excess);
    recs.push({
      priority: 'CRITICAL', type: 'HEAT_VIOLATION',
      message: `Portfolio heat at ${liveCnt}% — exceeds 10% cap by ${excess} slot${excess !== 1 ? 's' : ''}`,
      actions: candidates.map(p => ({ ticker: p.ticker, action: 'CLOSE', shares: filledSharesOf(p), reason: `Worst performer at ${pnlPctOf(p).toFixed(1)}%` })),
      alternative: `Or reduce share count on ${excess} position${excess !== 1 ? 's' : ''} to bring dollar risk within 1% each.`,
    });
  }

  // Rule 2: Sector Concentration (>3 per sector)
  const bySector = {};
  for (const p of livePos) { const s = p.sector || 'Unknown'; (bySector[s] = bySector[s] || []).push(p); }
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
      const priceReady = p.direction === 'LONG' ? (p.currentPrice ?? 0) >= trigger : (p.currentPrice ?? 0) <= trigger;
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

  // Rule 8: Dollar Risk Exceeds 1% Vitality
  for (const p of positions) {
    if (isRecycledPos(p)) continue;
    const shares = filledSharesOf(p);
    if (!shares) continue;
    const riskPerShare = Math.abs(avgCostOf(p) - p.stopPrice);
    if (!riskPerShare) continue;
    const posRisk = shares * riskPerShare;
    const vitality = nav * 0.01;
    if (posRisk > vitality * 1.1) {
      const maxShares = Math.floor(vitality / riskPerShare);
      const excessShares = shares - maxShares;
      recs.push({
        priority: 'HIGH', type: 'RISK_EXCEEDED',
        message: `${p.ticker}: $${posRisk.toFixed(0)} at risk exceeds 1% Vitality ($${vitality.toFixed(0)}).`,
        actions: [{ ticker: p.ticker, action: 'TRIM', shares: excessShares, reason: `Sell ${excessShares} shares to bring risk within 1%` }],
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

// ── Pyramid Card (position row) ───────────────────────────────────────────────

function PyramidCard({ position, netLiquidity, onUpdate, onUpdateStop, onUpdatePrice, flashed }) {
  const [expanded,    setExpanded]    = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [ev,          setEv]          = useState({});
  const [editingStop, setEditingStop] = useState(false);
  const [stopVal,     setStopVal]     = useState('');

  const sizingStop = position.originalStop || position.stopPrice;
  const pc   = sizePosition({ netLiquidity, entryPrice: position.entryPrice, stopPrice: sizingStop, maxGapPct: position.maxGapPct || 0, direction: position.direction });
  const rawLots = buildLots({ entryPrice: position.entryPrice, stopPrice: sizingStop, totalShares: pc.totalShares, direction: position.direction, fills: position.fills });
  const lots = enrichLots(rawLots, position.entryPrice, position.stopPrice, position.direction);
  const isLong      = position.direction === 'LONG';
  const highFilled  = Math.max(...lots.filter(l => l.filled).map(l => l.lot), 0);
  const totShr  = lots.reduce((s, l) => s + (l.filled ? l.actualShares : 0), 0);
  const totCost = lots.reduce((s, l) => s + (l.filled ? l.costBasis    : 0), 0);
  const avg     = totShr > 0 ? totCost / totShr : position.entryPrice;
  const pnl     = isLong ? ((position.currentPrice - avg) / avg * 100) : ((avg - position.currentPrice) / avg * 100);
  const pnl$    = isLong ? (position.currentPrice - avg) * totShr       : (avg - position.currentPrice) * totShr;
  const pC      = pnl >= 0 ? '#28a745' : '#dc3545';
  const posVal  = totShr * position.currentPrice;
  const next    = lots.find(l => l.lot === highFilled + 1);
  const nextDist = next ? (isLong ? (next.triggerPrice - position.currentPrice) / position.currentPrice * 100
                                  : (position.currentPrice - next.triggerPrice) / position.currentPrice * 100) : null;
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
    setEditing(n);
    setEv({ price: l.actualPrice || l.triggerPrice, shares: l.filled ? l.actualShares : l.targetShares, date: l.actualDate || new Date().toISOString().split('T')[0] });
    if (n === 1) { setEditingStop(true); setStopVal(position.stopPrice.toString()); }
  };
  const save = (n) => {
    const nf = { ...position.fills };
    nf[n] = { filled: true, price: +ev.price, shares: +ev.shares, date: ev.date };
    onUpdate(position.id, nf);
    if (n === 1 && editingStop) { const v = parseFloat(stopVal); if (v) onUpdateStop(position.id, v); }
    setEditing(null); setEditingStop(false);
  };
  const unfill = (n) => {
    const nf = { ...position.fills };
    for (let i = n; i <= 5; i++) nf[i] = { filled: false };
    onUpdate(position.id, nf); setEditing(null); setEditingStop(false);
  };
  const saveStopOnly = () => { const v = parseFloat(stopVal); if (v) onUpdateStop(position.id, v); setEditingStop(false); };
  const startStopOnly = () => { setEditingStop(true); setStopVal(position.stopPrice.toString()); };

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
          <span style={{ fontSize: 17, fontWeight: 800, fontFamily: 'monospace' }}>{position.ticker}</span>
          <SigBadge d={position.direction} />
          {isRecycled && <Badge color="#0f5132" bg="#d1e7dd" small>RECYCLED</Badge>}
          {!isRecycled && actualRisk > 0 && <Badge color="#ffc107" bg="rgba(255,193,7,0.1)" small>${actualRisk.toFixed(0)} AT RISK</Badge>}
          {hasFloor && <Badge color="#28a745" bg="rgba(40,167,69,0.1)" small>FLOOR +${pnlFloor.toFixed(0)}</Badge>}
          {staleLevel === 3 && <Badge color="#fff" bg="rgba(220,53,69,0.5)" small>LIQUIDATE {tradDays}/20</Badge>}
          {staleLevel === 2 && <Badge color="#000" bg="rgba(255,140,0,0.75)" small>STALE {tradDays}/20</Badge>}
          {staleLevel === 1 && <Badge color="#664d03" bg="#fff3cd" small>STALE {tradDays}/20</Badge>}
          {t2blocked && <Badge color="#664d03" bg="#fff3cd" small>GATE {Math.max(0, 5 - tradDays)}d</Badge>}
          <span style={{ fontSize: 11, color: '#555' }}>{position.sector}</span>
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
            <div style={{ fontSize: 10, color: '#666' }}>Current</div>
            <input type="number" step="0.01" key={position.id + '-price-' + position.currentPrice}
              defaultValue={position.currentPrice}
              onBlur={e => { const v = parseFloat(e.target.value); if (v && v !== position.currentPrice) onUpdatePrice(position.id, v); }}
              onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(e.target.value); if (v) { onUpdatePrice(position.id, v); e.target.blur(); } } }}
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4, padding: '2px 6px', color: '#e8e6e3', fontSize: 15, fontFamily: 'monospace',
                fontWeight: 700, width: 80, textAlign: 'right', outline: 'none' }}
              onFocus={e => { e.target.style.borderColor = '#FFD700'; e.target.style.color = '#FFD700'; }}
            />
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
          <span>{totShr}/{pc.totalShares} shares · Avg: ${avg.toFixed(2)}</span>
          <span>{isRecycled ? 'RECYCLED · ' : actualRisk > 0 ? `$${actualRisk.toFixed(0)} risk · ` : ''}Value: ${posVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
      </div>

      {/* Expanded order table */}
      {expanded && (
        <div>
          <div style={{ padding: '6px 18px', display: 'flex', gap: 16, fontSize: 11, color: '#777',
            background: 'rgba(0,0,0,0.15)', borderTop: '1px solid rgba(255,255,255,0.04)',
            borderBottom: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap' }}>
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
                const bg     = l.filled ? 'rgba(40,167,69,0.04)' : isNext ? (gated ? 'rgba(255,193,7,0.03)' : 'rgba(255,215,0,0.04)') : 'transparent';
                const tc     = l.filled ? '#28a745' : isNext ? (gated ? '#ffc107' : '#FFD700') : '#555';
                const showStopInput = i === 0;
                return (
                  <tr key={i} style={{ background: bg, borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td style={{ padding: '8px 8px', fontWeight: 700, color: tc, textAlign: 'right' }}>#{l.lot}</td>
                    <td style={{ padding: '8px 8px', fontFamily: 'sans-serif', fontSize: 11, fontWeight: 600, color: tc, textAlign: 'center' }}>{l.name}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: '#666', fontSize: 11 }}>{l.targetShares} ({l.pctLabel}%)</td>
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
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          <button onClick={() => save(l.lot)} style={{ background: '#28a745', color: '#fff', border: 'none', borderRadius: 3, padding: '3px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>SAVE</button>
                          <button onClick={() => { setEditing(null); setEditingStop(false); }} style={{ background: 'none', color: '#888', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '3px 6px', fontSize: 10, cursor: 'pointer' }}>✕</button>
                        </div>
                      ) : (showStopInput && editingStop && !ed) ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          <button onClick={saveStopOnly} style={{ background: '#28a745', color: '#fff', border: 'none', borderRadius: 3, padding: '3px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>SAVE</button>
                          <button onClick={() => setEditingStop(false)} style={{ background: 'none', color: '#888', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '3px 6px', fontSize: 10, cursor: 'pointer' }}>✕</button>
                        </div>
                      ) : l.filled ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                          <Badge color="#0f5132" bg="#d1e7dd" small>FILLED</Badge>
                          <button onClick={() => startEdit(l.lot)} style={{ background: 'none', color: '#888', border: 'none', fontSize: 10, cursor: 'pointer', textDecoration: 'underline' }}>edit</button>
                          {showStopInput && !editingStop && <button onClick={startStopOnly} style={{ background: 'none', color: '#dc3545', border: 'none', fontSize: 10, cursor: 'pointer', textDecoration: 'underline' }}>stop</button>}
                          {l.lot === highFilled && <button onClick={() => unfill(l.lot)} style={{ background: 'none', color: '#dc3545', border: 'none', fontSize: 10, cursor: 'pointer' }}>✕</button>}
                        </div>
                      ) : isNext ? (
                        gated
                          ? <Badge color="#664d03" bg="#fff3cd" small>GATE {Math.max(0, 5 - tradDays)}d</Badge>
                          : <button onClick={() => startEdit(l.lot)} style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 3, padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>FILL</button>
                      ) : <Badge color="#555" small>{isLong ? 'BUY' : 'SELL'} LMT</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
          <Badge color="#FFD700" bg="rgba(255,215,0,0.08)" small>{heat.slots} open slots</Badge>
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

export default function CommandCenter() {
  const { currentUser, updateCurrentUser } = useAuth();
  const [nav,           setNav]           = useState(() => currentUser?.accountSize ?? 100000);
  const navSaveTimer = useRef(null);

  // Debounce-save nav to profile whenever it changes (1s after last keystroke)
  function handleNavChange(value) {
    setNav(value);
    if (navSaveTimer.current) clearTimeout(navSaveTimer.current);
    navSaveTimer.current = setTimeout(() => {
      updateUserProfile({ accountSize: value })
        .then(() => updateCurrentUser({ accountSize: value }))
        .catch(() => {}); // silent — UI still works even if save fails
    }, 1000);
  }
  const [positions,     setPositions]     = useState([]);
  const [tab,           setTab]           = useState('positions');
  const [loading,       setLoading]       = useState(true);
  const [saving,        setSaving]        = useState(false);
  const [sectorWarning, setSectorWarning] = useState(null);

  const heat        = useMemo(() => calcHeat(positions, nav),        [positions, nav]);
  const advisorRecs = useMemo(() => runRiskAdvisor(positions, nav), [positions, nav]);

  // ── Auto-refresh state ─────────────────────────────────────────────────────
  const [lastRefresh,    setLastRefresh]    = useState(null);
  const [refreshing,     setRefreshing]     = useState(false);
  const [flashedTickers, setFlashedTickers] = useState(new Set());
  const refreshFnRef  = useRef(null);
  const flashTimerRef = useRef(null);

  const refreshPrices = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const data = await apiGet('/api/positions');
      if (data.positions?.length) {
        setPositions(prev => {
          const freshMap = {};
          for (const fp of data.positions) freshMap[fp.id] = fp;
          const changed = new Set();
          const merged = prev.map(p => {
            const fp = freshMap[p.id];
            if (!fp) return p;
            if (fp.currentPrice !== p.currentPrice) changed.add(p.ticker);
            return { ...p, currentPrice: fp.currentPrice, feastAlert: fp.feastAlert,
                     feastRSI: fp.feastRSI, tradingDaysActive: fp.tradingDaysActive };
          });
          if (changed.size > 0) {
            setFlashedTickers(changed);
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            flashTimerRef.current = setTimeout(() => setFlashedTickers(new Set()), 2500);
          }
          return merged;
        });
      }
      setLastRefresh(new Date());
    } catch { /* silent — prices stay as-is */ }
    setRefreshing(false);
  }, [refreshing]);

  // Keep ref in sync so the interval always calls the latest closure
  useEffect(() => { refreshFnRef.current = refreshPrices; }, [refreshPrices]);

  // 60-second auto-refresh during market hours only
  useEffect(() => {
    const timer = setInterval(() => {
      if (isMarketHours()) refreshFnRef.current?.();
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // Load positions from API on mount
  useEffect(() => {
    apiGet('/api/positions')
      .then(data => {
        if (data.positions?.length) setPositions(data.positions);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Save position changes to API (debounced via a brief timeout)
  const persistPosition = useCallback(async (position) => {
    setSaving(true);
    try {
      await apiPost('/api/positions', position);
    } catch { /* non-fatal — UI stays updated */ }
    setSaving(false);
  }, []);

  const updateFills = useCallback((id, fills) => {
    setPositions(prev => {
      const updated = prev.map(x => x.id === id ? { ...x, fills } : x);
      const pos = updated.find(x => x.id === id);
      if (pos) persistPosition(pos);
      return updated;
    });
  }, [persistPosition]);

  const updateStop = useCallback((id, newStop) => {
    setPositions(prev => {
      const updated = prev.map(x => x.id === id ? { ...x, stopPrice: newStop } : x);
      const pos = updated.find(x => x.id === id);
      if (pos) persistPosition(pos);
      return updated;
    });
  }, [persistPosition]);

  const updatePrice = useCallback((id, newPrice) => {
    setPositions(prev => prev.map(x => x.id === id ? { ...x, currentPrice: newPrice } : x));
    // Don't auto-save price (FMP provides live prices; only save if no live data)
  }, []);

  const createPosition = useCallback(async (data) => {
    const pos = { id: Date.now(), ...data };
    setPositions(prev => [...prev, pos]);
    setTab('positions');
    try {
      const result = await apiPost('/api/positions', pos);
      if (result.warning?.type === 'SECTOR_CONCENTRATION') {
        setSectorWarning(result.warning.message);
        // Auto-dismiss after 10 seconds
        setTimeout(() => setSectorWarning(null), 10000);
      }
    } catch { /* non-fatal */ }
  }, [setSectorWarning]);

  const tabs = [
    { id: 'positions',  l: 'Positions & Orders' },
    { id: 'calculator', l: 'New Position' },
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
              background: heat.theoPct > 8 ? '#dc3545' : heat.theoPct > 5 ? '#ffc107' : '#28a745' }} />
            <span style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
              {heat.theoPct}% heat · ${heat.actual$} actual · {heat.slots} slots
            </span>
          </div>
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
              <MC label="1% Vitality" value={`$${(nav * 0.01).toLocaleString()}`} accent="#28a745" />
              <MC label="Live heat" value={`${heat.theoPct}%`}
                sub={`${heat.liveCnt} × 1% slots`}
                sub2={`Actual risk: $${heat.actual$.toLocaleString()} (${heat.actualPct}%)`}
                accent={heat.theoPct > 8 ? '#dc3545' : '#28a745'} />
              <MC label="Recycled" value={heat.recycledCnt} sub="Stop ≥ entry = $0 risk" accent="#28a745" />
              <MC label="Open slots" value={heat.slots} accent="#FFD700" />
              <MC label="Total positions" value={heat.totalPos} sub={`${heat.liveCnt} live · ${heat.recycledCnt} recycled`} />
            </div>

            {/* Risk Advisor — runs every time positions load */}
            {!loading && <RiskAdvisor recommendations={advisorRecs} />}

            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#555' }}>Loading positions…</div>
            ) : positions.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#555', fontSize: 13 }}>
                No active positions. Use the <button onClick={() => setTab('calculator')}
                  style={{ background: 'none', border: 'none', color: '#FFD700', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  New Position</button> tab to add one, or check the Kill Pipeline for setups.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {positions.map(p => (
                  <PyramidCard key={p.id} position={p} netLiquidity={nav}
                    onUpdate={updateFills} onUpdateStop={updateStop} onUpdatePrice={updatePrice}
                    flashed={flashedTickers.has(p.ticker)} />
                ))}
              </div>
            )}
          </div>
        )}
        {tab === 'calculator' && <Calculator netLiquidity={nav} onCreate={createPosition} />}
        {tab === 'pipeline'   && <PipelineTab positions={positions} nav={nav} />}
      </div>
    </div>
  );
}
