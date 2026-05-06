// client/src/components/RiskAdvisorModal.jsx
// ── PNTHR Risk Advisor — modal launched from Assistant top-bar ───────────────
//
// Day 1 UI consolidation: extracted from CommandCenter.jsx as a self-contained
// modal so the Command Center page can be retired. Behavior identical to the
// inline panel that lived above the Command Center grid — same recommendations
// engine, same Option A (close weakest) and Option B (Kill candidates).
//
// Data flow: modal self-fetches positions / NAV / sector exposure when opened.
// No prop drilling from AssistantPage.
//
// Props:
//   open      (bool)   — show/hide
//   onClose   (fn)     — invoked on backdrop click / Escape / Close button
//   onOpenChart (fn?)  — passed through to ticker chips (signature: (rows, idx))
//
// Note: the in-modal "CLOSE [ticker]" button posts directly to the same
// /api/positions/close endpoint the Command Center used. This is the canonical
// close path (recordExit). No new write paths introduced.

import { useState, useMemo, useEffect } from 'react';
import { API_BASE, authHeaders, fetchNav, fetchSectorExposure } from '../services/api';
import { calcHeat, isEtfTicker, sizePosition } from '../utils/sizingUtils.js';

// ── Helpers (lifted verbatim from CommandCenter.jsx) ─────────────────────────

function getDisplayPrice(p) {
  const ov = p.manualPriceOverride;
  if (!ov?.active) return p.currentPrice ?? 0;
  return ov.price;
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

function runRiskAdvisor(positions, nav) {
  const recs = [];
  if (!positions.length || !nav) return recs;

  const livePos = positions.filter(p => !isRecycledPos(p));

  // Rule 1: Heat Cap Violation
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

  // Rule 2: Sector Net Directional Exposure (ADVISORY) — ETFs exempt
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

  // Rule 3: Stale Hunt
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

  // Rule 4: Lot 2 Ready
  for (const p of positions) {
    if (highestFilledLot(p) === 1 && (p.tradingDaysActive ?? 0) >= 5) {
      const lot1Price = p.fills?.[1]?.price;
      if (!lot1Price) continue;
      const trigger = p.direction === 'LONG' ? +(lot1Price * 1.03).toFixed(2) : +(lot1Price * 0.97).toFixed(2);
      const priceReady = p.direction === 'LONG' ? getDisplayPrice(p) >= trigger : getDisplayPrice(p) <= trigger;
      if (priceReady) {
        // Use originalStop for sizing (the locked-in 1% NAV plan from entry),
        // not the current ratcheted stop. Otherwise, ratcheted positions get
        // a falsely-inflated target and Lot 2 recommendations push past the
        // original 1% risk discipline. Mirrors AssistantLiveTable badge fix.
        const sizing = sizePosition({ netLiquidity: nav, entryPrice: p.entryPrice, stopPrice: (p.originalStop || p.stopPrice), maxGapPct: p.maxGapPct || 0, direction: p.direction });
        const lot2Shares = Math.round(sizing.totalShares * 0.25);
        recs.push({
          priority: 'ACTION', type: 'LOT2_READY',
          message: `${p.ticker}: Lot 2 (The Stalk) is READY. Price and time gate both confirmed.`,
          actions: [{ ticker: p.ticker, action: 'BUY', shares: lot2Shares, price: trigger, reason: 'Scale in 25% — Lot 2 trigger met' }],
        });
      }
    }
  }

  // Rule 5: Stop Ratchet Needed
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

  // Rule 7: Position Oversized
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

  // Rule 8: Dollar Risk Exceeds Vitality
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

// ── RecommendationsBody — the actual list (no header, no toggle) ─────────────
// The original RiskAdvisor was a collapsible inline panel; the modal version
// drops the collapse header and renders the body directly, with a modal-style
// header above.

function RecommendationsBody({ recommendations, sectorRecs, positions, onOpenChart, onCloseClick }) {
  if (recommendations.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#28a745', fontWeight: 600, fontSize: 14 }}>
        ✓ All Clear — Portfolio healthy.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {recommendations.map((rec, i) => {
        const s = PRIORITY_STYLE[rec.priority] || PRIORITY_STYLE.HIGH;

        if (rec.type === 'SECTOR_NET_EXPOSURE') {
          const isCrit = rec.priority === 'CRITICAL';
          const accentColor = isCrit ? '#dc3545' : '#ffc107';
          const serverRec  = sectorRecs.find(r => r.sector === rec.sector);
          const balanceOpt = serverRec?.options?.find(o => o.type === 'BALANCE');
          const candidates = balanceOpt?.candidateDetails || [];
          const oppositeDir = rec.netDirection === 'LONG' ? 'short' : 'long';
          return (
            <div key={i} style={{ background: s.bg, border: `1px solid ${accentColor}`, borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: accentColor }}>
                  {isCrit ? '●' : '⚠'} {rec.sector.toUpperCase()} — Net Exposure: {rec.netExposure} {rec.netDirection}
                </span>
                <span style={{ fontSize: 10, background: accentColor, color: '#000', padding: '2px 8px', borderRadius: 4, fontWeight: 700 }}>
                  {isCrit ? 'CRITICAL' : 'AT LIMIT'}
                </span>
              </div>
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
                {rec.longCount > 0 && rec.shortCount > 0 && <span style={{ color: '#555' }}>vs</span>}
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
                      {pos && onCloseClick && (
                        <button
                          onClick={() => onCloseClick(pos, rec.sector, rec.netExposure)}
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
  );
}

// ── Modal shell ──────────────────────────────────────────────────────────────

export default function RiskAdvisorModal({ open, onClose, onOpenChart }) {
  const [positions,   setPositions]   = useState([]);
  const [nav,         setNav]         = useState(null);
  const [sectorRecs,  setSectorRecs]  = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [closingId,   setClosingId]   = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [posRes, navVal, sectorVal] = await Promise.all([
          fetch(`${API_BASE}/api/positions`, { headers: authHeaders() }).then(r => r.json()),
          fetchNav().catch(() => null),
          fetchSectorExposure().catch(() => ({ options: [] })),
        ]);
        if (cancelled) return;
        setPositions(Array.isArray(posRes?.positions) ? posRes.positions : (Array.isArray(posRes) ? posRes : []));
        setNav(navVal);
        setSectorRecs(Array.isArray(sectorVal?.options) ? sectorVal.options : (Array.isArray(sectorVal) ? sectorVal : []));
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load risk data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const recommendations = useMemo(() => runRiskAdvisor(positions, nav), [positions, nav]);

  const handleCloseClick = async (pos /*, sector, netExposure */) => {
    if (!pos?.id || closingId) return;
    if (!window.confirm(`Close ${pos.ticker} at market? This will record the exit canonically.`)) return;
    setClosingId(pos.id);
    try {
      const r = await fetch(`${API_BASE}/api/positions/close`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: pos.id, exitReason: 'RISK_ADVISOR' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      // Refresh positions in the modal so the closed one disappears
      const fresh = await fetch(`${API_BASE}/api/positions`, { headers: authHeaders() }).then(x => x.json());
      setPositions(Array.isArray(fresh?.positions) ? fresh.positions : (Array.isArray(fresh) ? fresh : []));
    } catch (e) {
      alert(`Close failed: ${e.message}`);
    } finally {
      setClosingId(null);
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={() => onClose?.()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        zIndex: 1100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 20, overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose?.(); }}
        style={{
          background: '#111', border: '1px solid rgba(252,240,0,0.35)',
          borderRadius: 8, padding: 22,
          width: 880, maxWidth: '95vw',
          marginTop: 40, marginBottom: 40,
          color: '#e6e6e6', fontFamily: "'Inter', 'Segoe UI', sans-serif",
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14,
        }}>
          <div style={{ color: '#FCF000', fontWeight: 900, fontSize: 14, letterSpacing: '0.1em' }}>
            ⚡ RISK ADVISOR
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            style={{
              padding: '5px 12px', background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)', color: '#e6e6e6',
              borderRadius: 4, fontSize: 11, cursor: 'pointer', letterSpacing: '0.05em',
            }}
          >CLOSE ✕</button>
        </div>

        {loading && (
          <div style={{ padding: 32, textAlign: 'center', color: '#888' }}>Loading risk data…</div>
        )}
        {error && !loading && (
          <div style={{
            padding: '8px 10px', marginBottom: 10,
            background: 'rgba(220,53,69,0.1)',
            border: '1px solid rgba(220,53,69,0.4)',
            borderRadius: 4, color: '#dc3545',
            fontSize: 12, fontWeight: 600,
          }}>{error}</div>
        )}
        {!loading && !error && (
          <RecommendationsBody
            recommendations={recommendations}
            sectorRecs={sectorRecs}
            positions={positions}
            onOpenChart={onOpenChart}
            onCloseClick={handleCloseClick}
          />
        )}
      </div>
    </div>
  );
}
