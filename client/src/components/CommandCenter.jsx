// client/src/components/CommandCenter.jsx
// ── PNTHR Command Center — Portfolio Management Dashboard ─────────────────────
//
// Tier A pyramiding: 35-25-20-12-8 · Editable fills, stops, prices
// Live position data from /api/positions + kill signals from /api/kill-pipeline
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from 'react';
import { API_BASE, authHeaders, updateUserProfile, fetchNav, fetchPendingEntries, confirmPendingEntry, dismissPendingEntry, deletePosition, fetchSectorExposure } from '../services/api.js';
import { useAuth } from '../AuthContext';
import { useDemo } from '../contexts/DemoContext';
import { STRIKE_PCT, LOT_NAMES, LOT_OFFSETS, LOT_TIME_GATES, buildLots, enrichLots, sizePosition, calcHeat, isEtfTicker } from '../utils/sizingUtils.js';
import ChartModal from './ChartModal';
import pantherHead from '../assets/panther head.png';

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
  if (p.manualAvgCost) return +p.manualAvgCost;
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

// dollarAtRisk — mirrors PyramidCard actualRisk calculation; used for default sort
function dollarAtRisk(p) {
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

  // Rule 2: Sector Net Directional Exposure (ADVISORY ONLY) — ETFs exempt
  // Net Exposure = |longs - shorts|; no hard cap (Fund manager-discretion policy);
  // informational labels: HEIGHTENED if ≥4, ELEVATED if =3, CLEAR otherwise
  const bySector = {};
  for (const p of livePos) {
    if (p.isETF || isEtfTicker(p.ticker)) continue;
    const s = p.sector || 'Unknown';
    if (!bySector[s]) bySector[s] = { longs: [], shorts: [] };
    const dir = (p.direction || '').toUpperCase();
    if (dir === 'LONG') bySector[s].longs.push(p);
    else bySector[s].shorts.push(p);
  }
  for (const [sector, { longs, shorts }] of Object.entries(bySector)) {
    const netExposure  = Math.abs(longs.length - shorts.length);
    const netDirection = longs.length >= shorts.length ? 'LONG' : 'SHORT';
    if (netExposure >= 4) {
      const excess   = netExposure - 2;
      const heavySide = netDirection === 'LONG' ? longs : shorts;
      const weakest  = [...heavySide].sort((a, b) => pnlPctOf(a) - pnlPctOf(b)).slice(0, excess);
      recs.push({
        priority: 'CRITICAL', type: 'SECTOR_NET_EXPOSURE',
        sector, netExposure, netDirection,
        longCount: longs.length, shortCount: shorts.length,
        longTickers:  longs.map(p => ({ ticker: p.ticker, price: p.currentPrice })),
        shortTickers: shorts.map(p => ({ ticker: p.ticker, price: p.currentPrice })),
        message: `${sector}: net ${netExposure} ${netDirection} (${longs.length}L / ${shorts.length}S). Close ${excess} or add ${excess} ${netDirection === 'LONG' ? 'short' : 'long'}${excess > 1 ? 's' : ''}.`,
        actions: weakest.map(p => ({ ticker: p.ticker, action: 'CLOSE', shares: filledSharesOf(p), reason: `Weakest in ${sector} at ${pnlPctOf(p).toFixed(1)}%` })),
      });
    } else if (netExposure === 3) {
      recs.push({
        priority: 'HIGH', type: 'SECTOR_NET_EXPOSURE',
        sector, netExposure, netDirection,
        longCount: longs.length, shortCount: shorts.length,
        longTickers:  longs.map(p => ({ ticker: p.ticker, price: p.currentPrice })),
        shortTickers: shorts.map(p => ({ ticker: p.ticker, price: p.currentPrice })),
        message: `${sector}: at net exposure limit (${longs.length}L / ${shorts.length}S = net 3 ${netDirection}). No new ${netDirection.toLowerCase()}s without a balancing ${netDirection === 'LONG' ? 'short' : 'long'}.`,
        actions: [],
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
        const lot2Shares = Math.round(sizing.totalShares * 0.25);
        recs.push({
          priority: 'ACTION', type: 'LOT2_READY',
          message: `${p.ticker}: Lot 2 (The Stalk) is READY. Price and time gate both confirmed.`,
          actions: [{ ticker: p.ticker, action: 'BUY', shares: lot2Shares, price: trigger, reason: 'Scale in 25% — Lot 2 trigger met' }],
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

function RiskAdvisor({ recommendations, sectorRecs = [], onOpenChart, positions = [], onRiskAdvisorClose }) {
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

            // Rich display for net directional exposure recs
            if (rec.type === 'SECTOR_NET_EXPOSURE') {
              const isCrit = rec.priority === 'CRITICAL';
              const accentColor = isCrit ? '#dc3545' : '#ffc107';
              // Look up enriched server rec for this sector (has candidateDetails from Kill pipeline)
              const serverRec  = sectorRecs.find(r => r.sector === rec.sector);
              const balanceOpt = serverRec?.options?.find(o => o.type === 'BALANCE');
              const candidates = balanceOpt?.candidateDetails || [];
              const oppositeDir = rec.netDirection === 'LONG' ? 'short' : 'long';
              return (
                <div key={i} style={{ background: s.bg, border: `1px solid ${accentColor}`, borderRadius: 8, padding: '10px 14px' }}>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: accentColor }}>
                      {isCrit ? '●' : '⚠'} {rec.sector.toUpperCase()} — Net Exposure: {rec.netExposure} {rec.netDirection}
                    </span>
                    <span style={{ fontSize: 10, background: accentColor, color: '#000', padding: '2px 8px', borderRadius: 4, fontWeight: 700 }}>
                      {isCrit ? 'CRITICAL' : 'AT LIMIT'}
                    </span>
                  </div>
                  {/* Breakdown — ticker chips */}
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                    <span>Positions:</span>
                    {(rec.longTickers || []).map((t, idx) => (
                      <button key={t.ticker} onClick={() => onOpenChart?.(rec.longTickers, idx)}
                        style={{ background: 'rgba(40,167,69,0.15)', border: '1px solid rgba(40,167,69,0.4)',
                          color: '#4ade80', padding: '1px 7px', borderRadius: 3, fontSize: 10,
                          fontWeight: 700, cursor: 'pointer', fontFamily: 'monospace' }}>
                        {t.ticker}
                      </button>
                    ))}
                    {rec.longCount > 0 && rec.shortCount > 0 && (
                      <span style={{ color: '#555' }}>vs</span>
                    )}
                    {(rec.shortTickers || []).map((t, idx) => (
                      <button key={t.ticker} onClick={() => onOpenChart?.(rec.shortTickers, idx)}
                        style={{ background: 'rgba(220,53,69,0.15)', border: '1px solid rgba(220,53,69,0.4)',
                          color: '#ff6b6b', padding: '1px 7px', borderRadius: 3, fontSize: 10,
                          fontWeight: 700, cursor: 'pointer', fontFamily: 'monospace' }}>
                        {t.ticker}
                      </button>
                    ))}
                    <span style={{ color: '#555' }}>= net {rec.netExposure} {rec.netDirection}</span>
                  </div>
                  {/* Option A */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
                    {rec.actions.length > 0 && (
                      <div style={{ fontSize: 11, color: '#dc3545', fontWeight: 600, marginBottom: 2 }}>
                        OPTION A: Close weakest {rec.netDirection.toLowerCase()} positions →
                      </div>
                    )}
                    {rec.actions.map((a, j) => {
                      const pos = (a.action === 'CLOSE' || a.action === 'LIQUIDATE') ? positions.find(p => p.ticker === a.ticker) : null;
                      return (
                        <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 8,
                          fontSize: 11, color: s.text, fontFamily: 'monospace',
                          paddingLeft: 8, borderLeft: `2px solid ${accentColor}` }}>
                          <span style={{ flex: 1 }}>→ {formatAction(a)}</span>
                          {pos && onRiskAdvisorClose && (
                            <button
                              onClick={() => onRiskAdvisorClose(pos, rec.sector, rec.netExposure)}
                              style={{
                                background: 'rgba(220,53,69,0.15)', border: '1px solid #dc3545',
                                color: '#dc3545', padding: '2px 10px', borderRadius: 4,
                                fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'sans-serif',
                                flexShrink: 0,
                              }}>
                              CLOSE
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* Option B — Kill pipeline candidates */}
                  {(() => {
                    const needed = rec.netExposure - 2;
                    const oppSignal = rec.netDirection === 'LONG' ? 'SS' : 'BL';
                    return (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: candidates.length > 0 ? 6 : 4 }}>
                          <span style={{ fontSize: 11, color: '#28a745', fontWeight: 600 }}>
                            {isCrit ? 'OPTION B:' : '►'} Add {needed} {oppositeDir} position{needed > 1 ? 's' : ''} in {rec.sector} to balance exposure →
                          </span>
                          {candidates.length > 0 && candidates.length < needed && (
                            <span style={{ fontSize: 10, color: '#ffc107', fontStyle: 'italic' }}>
                              ({candidates.length} of {needed} {oppSignal} candidates found)
                            </span>
                          )}
                        </div>
                        {candidates.length > 0 ? candidates.map((c, j) => (
                          <div key={c.ticker} style={{ display: 'flex', alignItems: 'center', gap: 10,
                            padding: '4px 0 4px 12px', borderLeft: '2px solid #28a745', marginBottom: 3 }}>
                            <span style={{ color: '#888', fontSize: 11, width: 16 }}>{j + 1}.</span>
                            <span style={{ color: '#FFD700', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
                              onClick={() => onOpenChart?.(
                                candidates.map(x => ({ ticker: x.ticker, signal: x.signal, price: x.currentPrice })),
                                j
                              )}>
                              {c.ticker}
                            </span>
                            {c.rank != null && <span style={{ color: '#888', fontSize: 11 }}>Kill #{c.rank}</span>}
                            <span style={{ color: '#aaa', fontSize: 11 }}>Score: {c.killScore}</span>
                            {c.tier && <span style={{ color: '#b8860b', fontSize: 10 }}>{c.tier}</span>}
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                              color: c.signal === 'SS' ? '#dc3545' : '#28a745',
                              border: `1px solid ${c.signal === 'SS' ? 'rgba(220,53,69,0.3)' : 'rgba(40,167,69,0.3)'}` }}>
                              {c.signal}{c.signalAge === 0 ? ' NEW' : c.signalAge != null ? ` ${c.signalAge}w` : ''}
                            </span>
                          </div>
                        )) : (
                          <div style={{ fontSize: 11, color: '#555', fontStyle: 'italic', paddingLeft: 12 }}>
                            No {oppSignal} candidates currently scored in {rec.sector}. Check the Kill page.
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            }

            // Default renderer for all other rec types
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

function PyramidCard({ position, netLiquidity, onUpdate, onUpdateStop, onUpdatePrice, onClearOverride, onDelete, onExitConfirmed, flashed, onOpenChart, onField, onDirectionChange }) {
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

  // ── Entry Conditions — pre-populate from Analyze snapshot ─────────────────
  const raw           = entry.analyzeScore?.rawData || {};
  const isNasdaq      = (entry.exchange || '').toUpperCase() === 'NASDAQ';
  const indexEtfName  = isNasdaq ? 'QQQ' : 'SPY';
  const indexAbove    = isNasdaq ? (raw.market?.qqq?.aboveEma ?? null) : (raw.market?.spy?.aboveEma ?? null);
  const sectorAbove   = raw.sector?.aboveEma ?? null;
  const sectorEtfName = raw.sector?.etf || (entry.sector ? `${entry.sector} ETF` : 'Sector ETF');
  const initDir       = entry.direction || 'LONG';
  const condAuto      = { index: indexAbove != null, sector: sectorAbove != null };
  const [conditions, setConditions] = useState({
    indexTrendAligned:  indexAbove  != null ? (initDir === 'LONG' ? indexAbove  : !indexAbove)  : null,
    sectorTrendAligned: sectorAbove != null ? (initDir === 'LONG' ? sectorAbove : !sectorAbove) : null,
    sizingCorrect: true,
  });

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
      await onConfirm(entry.id, {
        fillPrice: +fillPrice, shares: +shares, date, stop: +stop || undefined, direction,
        userConfirmed: {
          indexTrendAligned:  conditions.indexTrendAligned,
          sectorTrendAligned: conditions.sectorTrendAligned,
          sizingCorrect:      conditions.sizingCorrect,
          confirmedAt:        new Date().toISOString(),
        },
      });
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
          {entry.isManualOverride && (
            <span title="Manual override — queued from the OVERRIDE dialog on the chart; does not match the Friday system recommendation"
              style={{ fontSize: 10, fontWeight: 800, color: '#fff', background: '#2563eb',
                borderRadius: 3, padding: '2px 7px', letterSpacing: '0.08em' }}>
              OVERRIDE
            </span>
          )}
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

      {/* ── Entry Conditions ───────────────────────────────────────────────── */}
      <div style={{ padding: '8px 18px 12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ fontSize: 9, color: '#555', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
          Entry Conditions
          <span style={{ color: '#28a745', marginLeft: 5 }}>⚡</span>
          <span style={{ color: '#444', fontWeight: 400 }}> = auto-detected from Analyze · click to override</span>
        </div>
        {[
          { key: 'indexTrendAligned',  label: `${indexEtfName} ${isLong ? 'above' : 'below'} 21W EMA at entry?`,    auto: condAuto.index  },
          { key: 'sectorTrendAligned', label: `${sectorEtfName} ${isLong ? 'above' : 'below'} 21W EMA at entry?`,   auto: condAuto.sector },
          { key: 'sizingCorrect',      label: 'Used SIZE IT for Lot 1?',                     auto: false           },
        ].map(({ key, label, auto }) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
            <span style={{ fontSize: 10, color: '#777', flex: 1 }}>
              {label}
              {auto && <span style={{ color: '#28a745', marginLeft: 4, fontSize: 9 }}>⚡</span>}
            </span>
            {[true, false].map(val => (
              <button key={String(val)} onClick={() => setConditions(c => ({ ...c, [key]: val }))}
                style={{
                  background: conditions[key] === val
                    ? (val ? 'rgba(40,167,69,0.75)' : 'rgba(220,53,69,0.75)')
                    : 'rgba(255,255,255,0.05)',
                  color: conditions[key] === val ? '#fff' : '#444',
                  border: 'none', borderRadius: 3, padding: '2px 10px',
                  fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.04em',
                }}>
                {val ? 'YES' : 'NO'}
              </button>
            ))}
          </div>
        ))}
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
          <Badge color="#FFD700" bg="rgba(255,215,0,0.08)" small>TIER A · 35-25-20-12-8</Badge>
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

export default function CommandCenter({ onNavigate, refreshSignal }) {
  const { currentUser, updateCurrentUser } = useAuth();
  const { isDemo } = useDemo();
  const [commandFundPeriod, setCommandFundPeriod] = useState('full_backtest');
  const [liveFundNav, setLiveFundNav] = useState(null);
  const [nav,           setNav]           = useState(() => currentUser?.accountSize ?? 100000);
  const navSaveTimer    = useRef(null);
  const navLastEditedAt = useRef(0); // timestamp of last manual NAV edit
  const riskAdvisorRef  = useRef(null); // scroll target when arriving from Pulse "View risk advisor"

  // Debounce-save nav to profile whenever it changes (1s after last keystroke)
  function handleNavChange(value) {
    setNav(value);
    navLastEditedAt.current = Date.now(); // mark manual edit so auto-sync won't overwrite
    if (navSaveTimer.current) clearTimeout(navSaveTimer.current);
    navSaveTimer.current = setTimeout(() => saveNavNow(value), 1000);
  }

  // Immediate save — used on blur so refreshing right after editing still persists
  function saveNavNow(value) {
    if (navSaveTimer.current) { clearTimeout(navSaveTimer.current); navSaveTimer.current = null; }
    updateUserProfile({ accountSize: value })
      .then(() => updateCurrentUser({ accountSize: value }))
      .catch(() => {}); // silent — UI still works even if save fails
  }
  const [positions,       setPositions]       = useState([]);
  const [pendingEntries,  setPendingEntries]  = useState([]);
  const [sectorRecs,      setSectorRecs]      = useState([]); // enriched recs from /api/sector-exposure (has candidateDetails)
  const [tab,             setTab]             = useState('positions');
  const [loading,         setLoading]         = useState(true);
  const [saving,          setSaving]          = useState(false);
  const [sectorWarning,         setSectorWarning]         = useState(null);
  const [journalSnapshot,       setJournalSnapshot]       = useState(null); // { allCaptured, fields }
  const [chartModal,            setChartModal]            = useState(null); // { stocks, index }
  const [closedToast,           setClosedToast]           = useState(null); // { ticker, avgCost, exitPrice, pnlDollar, pnlPct }
  const [washWarning,           setWashWarning]           = useState(null); // { ticker, lossAmount, exitDate, expiryDate, daysRemaining, pendingId, fillData }
  const [riskAdvisorExitModal,  setRiskAdvisorExitModal]  = useState(null); // { position, shares, price, date, reason, note }
  const [ibkrLastSync,          setIbkrLastSync]          = useState(null); // global ibkrLastSync from user_profiles

  const heat        = useMemo(() => calcHeat(positions, nav),        [positions, nav]);
  const advisorRecs = useMemo(() => runRiskAdvisor(positions, nav), [positions, nav]);

  // Portfolio equity = NAV (cash + realized P&L) + unrealized P&L from open positions
  const portfolioEquity = useMemo(() => {
    let unrealized = 0;
    for (const p of positions) {
      const avg = avgCostOf(p);
      const shares = filledSharesOf(p);
      if (!avg || !shares || !p.currentPrice) continue;
      const pnl = p.direction === 'SHORT'
        ? (avg - p.currentPrice) * shares
        : (p.currentPrice - avg) * shares;
      unrealized += pnl;
    }
    return nav + unrealized;
  }, [positions, nav]);

  // ── Fund period toggle (demo mode) ──────────────────────────────────────────
  // When switching between "5 YEARS" and "PNTHR 6-16-25", swap NAV accordingly
  useEffect(() => {
    if (!isDemo) return;
    if (commandFundPeriod === 'live_fund') {
      // Fetch live fund NAV from profile
      fetchNav().then(profile => {
        if (profile?.liveFundNav) {
          setLiveFundNav(profile.liveFundNav);
          setNav(profile.liveFundNav);
        }
      }).catch(() => {});
    } else {
      // Switch back to full backtest NAV
      fetchNav().then(profile => {
        if (profile?.nav) {
          setNav(profile.nav);
        }
      }).catch(() => {});
    }
  }, [commandFundPeriod, isDemo]); // eslint-disable-line react-hooks/exhaustive-deps

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
          // Auto-deactivate overrides using timestamp priority:
          // Live price wins if it arrived AFTER the override was set.
          // This handles the common case of setting an after-hours override
          // that should clear automatically once the market opens and live
          // prices flow in. Overrides set during this session (no setAt, or
          // setAt >= refreshedAt) are kept — user just set them intentionally.
          const refreshedAt = new Date();
          return merged.map(p => {
            const ov = p.manualPriceOverride;
            if (!ov?.active) return p;
            const livePrice = p.currentPrice ?? 0;
            if (!livePrice || !ov.price) return p;
            // If the override has a timestamp and the live refresh is newer → live wins
            const overrideSetAt = ov.setAt ? new Date(ov.setAt) : null;
            if (overrideSetAt && refreshedAt > overrideSetAt) {
              toDeactivate.push(p.id);
              return { ...p, manualPriceOverride: { ...ov, active: false } };
            }
            // Legacy fallback: deactivate if live price within 0.1% of override
            const pctDiff = Math.abs(livePrice - ov.price) / ov.price;
            if (pctDiff <= 0.001) {
              toDeactivate.push(p.id);
              return { ...p, manualPriceOverride: { ...ov, active: false } };
            }
            return p;
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
          if (profile?.ibkrLastSync) setIbkrLastSync(new Date(profile.ibkrLastSync));
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

  // Scroll to Risk Advisor when arriving via Pulse "View risk advisor →" link
  useEffect(() => {
    if (!loading && sessionStorage.getItem('scrollToRiskAdvisor')) {
      sessionStorage.removeItem('scrollToRiskAdvisor');
      setTimeout(() => {
        riskAdvisorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300); // wait for DOM + positions to render
    }
  }, [loading]);

  // Re-fetch positions when a position is created externally (e.g. IBKR import from banner)
  useEffect(() => {
    if (!refreshSignal) return; // skip initial mount — handled by the mount effect below
    apiGet('/api/positions')
      .then(data => { if (data.positions?.length) setPositions(data.positions); })
      .catch(() => {});
  }, [refreshSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load positions, pending entries, and NAV on mount
  useEffect(() => {
    apiGet('/api/positions')
      .then(data => {
        if (data.positions?.length) setPositions(data.positions);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    fetchSectorExposure()
      .then(data => { if (data?.recommendations?.length) setSectorRecs(data.recommendations); })
      .catch(() => {});
    fetchPendingEntries()
      .then(data => { if (Array.isArray(data)) setPendingEntries(data); })
      .catch(() => {});
    // Pull latest NAV + IBKR last sync on mount
    fetchNav()
      .then(profile => {
        if (profile?.nav) {
          setNav(profile.nav);
          updateCurrentUser({ accountSize: profile.nav });
        }
        if (profile?.ibkrLastSync) setIbkrLastSync(new Date(profile.ibkrLastSync));
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

  const updateField = useCallback((id, fields) => {
    setPositions(prev => prev.map(x => x.id === id ? { ...x, ...fields } : x));
    patchPosition(id, fields);
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
      if (result.warning?.type === 'SECTOR_HEIGHTENED' || result.warning?.type === 'SECTOR_ELEVATED') {
        setSectorWarning(result.warning.message);
        setTimeout(() => setSectorWarning(null), 10000);
      }
    } catch { /* non-fatal */ }
  }, [setSectorWarning]);

  const handleConfirmEntry = useCallback(async (id, fillData, forceConfirm = false) => {
    // Pre-check for active wash sale window — show warning modal before confirming
    if (!forceConfirm) {
      const pEntry = pendingEntries.find(e => e.id === id);
      if (pEntry?.ticker) {
        try {
          const rules = await fetch(`${API_BASE}/api/wash-rules?ticker=${encodeURIComponent(pEntry.ticker)}`, { headers: authHeaders() })
            .then(r => r.ok ? r.json() : []).catch(() => []);
          const active = rules.find(w => !w.washSale?.triggered && (w.washSale?.daysRemaining ?? 0) > 0);
          if (active) {
            setWashWarning({
              ticker:        pEntry.ticker,
              lossAmount:    active.washSale.lossAmount,
              exitDate:      active.washSale.exitDate,
              expiryDate:    active.washSale.expiryDate,
              daysRemaining: active.washSale.daysRemaining,
              pendingId:     id,
              fillData,
            });
            return;
          }
        } catch { /* non-fatal — proceed with confirm */ }
      }
    }
    setWashWarning(null);
    const confirmResult = await confirmPendingEntry(id, fillData);
    if (confirmResult?.sectorWarning)  setSectorWarning(confirmResult.sectorWarning);
    if (confirmResult?.journalSnapshot) {
      setJournalSnapshot(confirmResult.journalSnapshot);
    }
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
  }, [pendingEntries, mergeServerPrices]);

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
      {/* Header — matches PNTHR Kill / Journal style */}
      <div style={{ padding: '16px 24px', background: '#111111',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src={pantherHead} alt="PNTHR" style={{ height: 36, width: 'auto' }} />
            <span style={{ fontSize: 20, fontWeight: 800, color: '#fcf000', letterSpacing: '0.02em' }}>PNTHR COMMAND</span>
          </div>
          <div style={{ height: 20, width: 1, background: 'rgba(255,255,255,0.12)' }} />
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
          {/* IBKR sync indicator — shows last sync time from bridge */}
          {(() => {
            const ibkrTs = ibkrLastSync || positions.find(p => p.ibkrSyncedAt)?.ibkrSyncedAt;
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
          {/* Refresh controls — LIVE is green only when market is open AND IBKR is actively syncing */}
          {(() => {
            const ibkrTs    = ibkrLastSync || positions.find(p => p.ibkrSyncedAt)?.ibkrSyncedAt;
            const ibkrFresh = ibkrTs && (Date.now() - new Date(ibkrTs).getTime()) < 300000;
            const market    = isMarketHours();
            const color     = market && ibkrFresh ? '#28a745' : market && !ibkrFresh ? '#FFD700' : '#555';
            const glow      = market && ibkrFresh ? '0 0 5px #28a745' : 'none';
            const label     = market && ibkrFresh ? 'LIVE' : market ? 'LIVE (no IBKR)' : 'CLOSED';
            return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: 3, background: color, boxShadow: glow }} />
            <span style={{ fontSize: 10, color }}>{label}</span>
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
            );
          })()}
          {/* ── Fund Period Toggle (demo account only) ── */}
          {isDemo && (
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #333', marginRight: 4 }}>
              <button
                onClick={() => { setCommandFundPeriod('full_backtest'); }}
                style={{
                  padding: '5px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer', border: 'none',
                  background: commandFundPeriod === 'full_backtest' ? '#fcf000' : '#1a1a1a',
                  color: commandFundPeriod === 'full_backtest' ? '#111' : '#888',
                  letterSpacing: 0.3,
                }}
              >5 YEARS</button>
              <button
                onClick={() => { setCommandFundPeriod('live_fund'); }}
                style={{
                  padding: '5px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer', border: 'none',
                  borderLeft: '1px solid #333',
                  background: commandFundPeriod === 'live_fund' ? '#fcf000' : '#1a1a1a',
                  color: commandFundPeriod === 'live_fund' ? '#111' : '#888',
                  letterSpacing: 0.3,
                }}
              >PNTHR 6-16-25</button>
            </div>
          )}
          <span style={{ fontSize: 11, color: '#555' }}>NAV</span>
          <input type="number" value={nav} onChange={e => handleNavChange(+e.target.value || 0)} onBlur={e => saveNavNow(+e.target.value || 0)}
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

          {/* Sector concentration warning banner — expandable with Kill candidates */}
            {sectorWarning && (() => {
              const warn        = typeof sectorWarning === 'string' ? { message: sectorWarning, suggestions: [] } : sectorWarning;
              const suggestions = warn.suggestions || [];
              const oppSignal   = warn.netDirection === 'LONG' ? 'SS' : 'BL';
              return (
                <div style={{ background: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.3)',
                  borderRadius: 8, marginBottom: 14, overflow: 'hidden' }}>
                  {/* Header row — always visible, click to expand */}
                  <div style={{ padding: '10px 16px', display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', cursor: suggestions.length ? 'pointer' : 'default' }}
                    onClick={() => suggestions.length && setSectorWarning(w => ({ ...w, _expanded: !w._expanded }))}>
                    <span style={{ fontSize: 12, color: '#ff6b6b', fontWeight: 600 }}>
                      ⚠ SECTOR CONCENTRATION: {warn.message}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {suggestions.length > 0 && (
                        <span style={{ fontSize: 10, color: '#ff6b6b', opacity: 0.7 }}>
                          {sectorWarning._expanded ? '▲ hide' : `▼ top ${suggestions.length} ${oppSignal} to balance`}
                        </span>
                      )}
                      <button onClick={e => { e.stopPropagation(); setSectorWarning(null); }}
                        style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer',
                          fontSize: 18, lineHeight: 1, padding: '0 4px' }}>×</button>
                    </div>
                  </div>

                  {/* Expanded: top Kill candidates to balance the sector */}
                  {sectorWarning._expanded && suggestions.length > 0 && (
                    <div style={{ borderTop: '1px solid rgba(220,53,69,0.2)', padding: '10px 16px',
                      background: 'rgba(220,53,69,0.04)' }}>
                      <div style={{ fontSize: 10, color: '#888', marginBottom: 8, letterSpacing: '0.06em', fontWeight: 700 }}>
                        TOP {oppSignal} CANDIDATES IN {(warn.sector || '').toUpperCase()} — click to open chart
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        {suggestions.map(s => (
                          <button key={s.ticker}
                            onClick={() => setChartModal({ stocks: [{ ticker: s.ticker, symbol: s.ticker, signal: s.signal, currentPrice: s.currentPrice }], index: 0 })}
                            style={{ background: 'rgba(239,83,80,0.1)', border: '1px solid rgba(239,83,80,0.35)',
                              borderRadius: 5, padding: '6px 12px', cursor: 'pointer',
                              display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                            <span style={{ fontSize: 13, fontWeight: 800, color: '#ef5350', letterSpacing: '0.04em' }}>
                              {s.ticker}
                            </span>
                            <span style={{ fontSize: 10, color: '#888' }}>
                              {s.tier ? s.tier.split(' ')[0] : ''} · Kill {s.score}
                              {s.currentPrice ? ` · $${s.currentPrice}` : ''}
                            </span>
                          </button>
                        ))}
                        {suggestions.length === 0 && (
                          <span style={{ fontSize: 11, color: '#666' }}>No {oppSignal} Kill signals found in this sector right now.</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          {/* Journal entry snapshot banner — auto-dismisses after 9s */}
          {/* Journal entry snapshot banner — stays until manually dismissed */}
            {journalSnapshot && (() => {
              const { allCaptured, isETF, fields } = journalSnapshot;
              const STOCK_LABELS = {
                killScore: 'Kill score', killRank: 'Kill rank', killTier: 'Kill tier',
                signal: 'Signal', signalAge: 'Signal age', entryContext: 'Entry context',
                indexTrend: 'Index trend', sectorTrend: 'Sector trend', regime: 'Regime',
              };
              const ETF_LABELS = { regime: 'Regime' };
              const FIELD_LABELS = isETF ? ETF_LABELS : STOCK_LABELS;
              const missing = Object.entries(fields || {})
                .filter(([, v]) => v == null)
                .map(([k]) => FIELD_LABELS[k] || k);
              const capturedMsg = isETF
                ? '⚡ ETF journal snapshot captured — regime auto-saved (Kill/signal fields N/A for ETFs)'
                : '⚡ Journal snapshot captured — Kill, signal, regime & market context auto-saved';
              const partialMsg = isETF
                ? '⚡ ETF journal snapshot partial — regime not captured (Kill/signal fields N/A for ETFs)'
                : '⚡ Journal snapshot partial — some fields need manual input at close';
              return (
                <div style={{
                  background: allCaptured ? 'rgba(40,167,69,0.1)' : 'rgba(255,193,7,0.1)',
                  border: `1px solid ${allCaptured ? 'rgba(40,167,69,0.4)' : 'rgba(255,193,7,0.4)'}`,
                  borderRadius: 8, marginBottom: 14, padding: '10px 14px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700,
                      color: allCaptured ? '#51cf66' : '#ffd43b', marginBottom: allCaptured ? 0 : 4 }}>
                      {allCaptured ? capturedMsg : partialMsg}
                    </div>
                    {!allCaptured && missing.length > 0 && (
                      <div style={{ fontSize: 11, color: '#999' }}>
                        Missing: {missing.join(', ')}
                      </div>
                    )}
                  </div>
                  <button onClick={() => setJournalSnapshot(null)}
                    style={{ background: 'none', border: 'none',
                      color: allCaptured ? '#51cf66' : '#ffd43b',
                      cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}>×</button>
                </div>
              );
            })()}

            {/* Metric cards */}
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isDemo ? 7 : 6}, 1fr)`, gap: 10, marginBottom: 16 }}>
              {isDemo && <MC label="Portfolio equity"
                value={`$${portfolioEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                sub={`${portfolioEquity >= nav ? '+' : ''}$${(portfolioEquity - nav).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} unrealized`}
                accent={portfolioEquity >= nav ? '#28a745' : '#dc3545'} />}
              <MC label={isDemo ? 'Net liquidity' : 'Net liquidity'} value={isDemo
                ? `$${nav.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : `$${Math.round(nav / 1000).toLocaleString()}K`} />
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
            <div ref={riskAdvisorRef}>
              {!loading && <RiskAdvisor
                recommendations={advisorRecs}
                sectorRecs={sectorRecs}
                positions={positions}
                onOpenChart={(tickerOrStocks, index = 0) => {
                  const arr = Array.isArray(tickerOrStocks)
                    ? tickerOrStocks.map(s => ({ ticker: s.ticker, symbol: s.ticker, signal: s.signal || null, currentPrice: s.price || null }))
                    : [{ ticker: tickerOrStocks, symbol: tickerOrStocks, currentPrice: null }];
                  setChartModal({ stocks: arr, index });
                }}
                onRiskAdvisorClose={(pos, sector, netExposure) => {
                  const totalShares = Object.values(pos.fills || {}).filter(f => f?.filled).reduce((s, f) => s + (+(f.shares ?? 0)), 0);
                  setRiskAdvisorExitModal({
                    position:    pos,
                    shares:      totalShares,
                    price:       pos.currentPrice ? pos.currentPrice.toFixed(2) : '',
                    date:        new Date().toISOString().split('T')[0],
                    reason:      'RISK_ADVISOR',
                    note:        `Sector concentration: ${sector} at net ${netExposure}. Closed per Risk Advisor recommendation.`,
                  });
                }}
              />}
            </div>

            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#555' }}>Loading positions…</div>
            ) : positions.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#555', fontSize: 13 }}>
                No active positions. Open a chart on the <span style={{ color: '#FFD700' }}>PNTHR Kill</span> page, click <span style={{ color: '#FFD700' }}>SIZE IT</span>, and queue setups to send here.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {(() => {
                  const sorted = [...positions].sort((a, b) => dollarAtRisk(b) - dollarAtRisk(a));
                  return sorted.map(p => (
                  <PyramidCard key={p.id} position={p} netLiquidity={nav}
                    onUpdate={updateFills} onUpdateStop={updateStop} onUpdatePrice={updatePrice}
                    onClearOverride={clearOverride} onField={updateField}
                    onDelete={handleDeletePosition}
                    onDirectionChange={async (id, newDir) => {
                      try {
                        await fetch(`${API_BASE}/api/positions/${id}/direction`, {
                          method: 'PATCH',
                          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                          body: JSON.stringify({ direction: newDir }),
                        });
                        setPositions(prev => prev.map(pos => pos.id === id ? { ...pos, direction: newDir } : pos));
                      } catch { alert('Failed to update direction. Please try again.'); }
                    }}
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
                      const stocks = sorted.map(pos => ({
                        ticker: pos.ticker, symbol: pos.ticker,
                        currentPrice: pos.currentPrice, signal: pos.signal,
                        sector: pos.sector, stopPrice: pos.stopPrice,
                      }));
                      const index = stocks.findIndex(s => s.ticker === clicked.ticker);
                      setChartModal({ stocks, index: Math.max(0, index) });
                    }} />
                  ));
                })()}
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
          onClose={() => setChartModal(null)}
        />
      )}

      {/* Wash sale warning modal — requires user acknowledgement before confirming entry */}
      {washWarning && (() => {
        const { ticker, lossAmount, exitDate, expiryDate, daysRemaining } = washWarning;
        const fmtD = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '—';
        return (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 400,
            background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              background: '#1a1a1a', border: '1px solid #dc3545', borderRadius: 10,
              padding: '24px 28px', maxWidth: 440, width: '90vw',
              boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
            }}>
              <div style={{ color: '#dc3545', fontWeight: 800, fontSize: '1.1rem', marginBottom: 12, letterSpacing: '0.03em' }}>
                ⚠ WASH SALE WARNING
              </div>
              <div style={{ color: '#ccc', lineHeight: 1.75, fontSize: 13, marginBottom: 20 }}>
                <b style={{ color: '#FFD700' }}>{ticker}</b> closed at a loss of{' '}
                <b style={{ color: '#dc3545' }}>-${Math.abs(lossAmount || 0).toFixed(2)}</b> on {fmtD(exitDate)}.<br/>
                Re-entering before <b style={{ color: '#FFD700' }}>{fmtD(expiryDate)}</b> ({daysRemaining}d remaining)
                will trigger a wash sale, <b style={{ color: '#fff' }}>disallowing that tax loss.</b>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  onClick={() => handleConfirmEntry(washWarning.pendingId, washWarning.fillData, true)}
                  style={{ background: '#dc3545', color: '#fff', padding: '8px 20px', borderRadius: 6, border: 'none', fontWeight: 700, cursor: 'pointer', fontSize: 12, letterSpacing: '0.05em' }}>
                  ENTER ANYWAY
                </button>
                <button
                  onClick={() => setWashWarning(null)}
                  style={{ background: 'transparent', color: '#888', padding: '8px 20px', borderRadius: 6, border: '1px solid #444', fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>
                  CANCEL
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Risk Advisor Exit modal — one-click close from Risk Advisor recommendation */}
      {riskAdvisorExitModal && (() => {
        const { position, shares, price, date, reason, note } = riskAdvisorExitModal;
        const avgCost = (() => {
          let cost = 0, sh = 0;
          for (let i = 1; i <= 5; i++) { const f = position.fills?.[i]; if (f?.filled && f.price) { cost += f.price * +(f.shares ?? 0); sh += +(f.shares ?? 0); } }
          return sh > 0 ? cost / sh : (position.entryPrice || 0);
        })();
        const priceNum = parseFloat(price) || 0;
        const diff = position.direction === 'SHORT' ? avgCost - priceNum : priceNum - avgCost;
        const pnlDollar = diff * shares;
        const pnlPct = avgCost > 0 ? diff / avgCost * 100 : 0;
        const pnlColor = pnlDollar >= 0 ? '#28a745' : '#dc3545';
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: '#1a1a1a', border: '1px solid #dc3545', borderRadius: 10, padding: '24px 28px', maxWidth: 480, width: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.8)' }}>
              <div style={{ color: '#dc3545', fontWeight: 800, fontSize: '1rem', marginBottom: 6, letterSpacing: '0.05em' }}>
                RISK ADVISOR EXIT — {position.ticker}
              </div>
              <div style={{ color: '#888', fontSize: 12, marginBottom: 16 }}>
                Close {shares} shares · Sector concentration risk
              </div>

              {/* P&L preview */}
              <div style={{ background: '#111', borderRadius: 6, padding: '8px 12px', marginBottom: 16, fontSize: 12, display: 'flex', gap: 20 }}>
                <span>Current P&L: <b style={{ color: pnlColor }}>{pnlDollar >= 0 ? '+' : ''}${pnlDollar.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)</b></span>
                <span style={{ color: '#555' }}>{shares} shr @ avg ${avgCost.toFixed(2)}</span>
              </div>

              {/* Exit price + date */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                <div>
                  <div style={{ color: '#888', fontSize: 11, marginBottom: 3 }}>EXIT PRICE</div>
                  <input
                    type="number" step="0.01" value={price}
                    onChange={e => setRiskAdvisorExitModal(prev => ({ ...prev, price: e.target.value }))}
                    style={{ background: '#111', border: '1px solid #444', color: '#fff', borderRadius: 4, padding: '5px 8px', fontSize: 13, width: '100%', boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <div style={{ color: '#888', fontSize: 11, marginBottom: 3 }}>DATE</div>
                  <input
                    type="date" value={date}
                    onChange={e => setRiskAdvisorExitModal(prev => ({ ...prev, date: e.target.value }))}
                    style={{ background: '#111', border: '1px solid #444', color: '#fff', borderRadius: 4, padding: '5px 8px', fontSize: 13, width: '100%', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              {/* Note */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ color: '#888', fontSize: 11, marginBottom: 3 }}>NOTE <span style={{ color: '#555' }}>(optional)</span></div>
                <textarea
                  value={note}
                  onChange={e => setRiskAdvisorExitModal(prev => ({ ...prev, note: e.target.value }))}
                  rows={2}
                  style={{ background: '#111', border: '1px solid #333', color: '#ccc', borderRadius: 4, padding: '5px 8px', fontSize: 12, width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  disabled={!price || !date}
                  onClick={async () => {
                    try {
                      const res = await fetch(`${API_BASE}/api/positions/${position.id}/exit`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify({ shares, price: +price, date, reason, note }),
                      });
                      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Exit failed'); }
                      const result = await res.json();
                      setRiskAdvisorExitModal(null);
                      // Handle exit result same as normal flow
                      if (result?.status === 'CLOSED') {
                        setPositions(prev => prev.filter(x => x.id !== position.id));
                        setClosedToast({ ticker: position.ticker, avgCost, exitPrice: +price, pnlDollar, pnlPct });
                        setTimeout(() => setClosedToast(null), 10000);
                      } else {
                        const data = await apiGet('/api/positions').catch(() => null);
                        if (data?.positions?.length) setPositions(prev => mergeAfterExit(prev, data.positions));
                      }
                    } catch (ex) { alert(ex.message || 'Exit failed'); }
                  }}
                  style={{ background: '#dc3545', color: '#fff', padding: '9px 20px', borderRadius: 6, border: 'none', fontWeight: 700, cursor: 'pointer', fontSize: 12, letterSpacing: '0.05em', opacity: (!price || !date) ? 0.5 : 1 }}>
                  CONFIRM EXIT
                </button>
                <button
                  onClick={() => setRiskAdvisorExitModal(null)}
                  style={{ background: 'transparent', color: '#888', padding: '9px 20px', borderRadius: 6, border: '1px solid #444', fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>
                  CANCEL
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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
