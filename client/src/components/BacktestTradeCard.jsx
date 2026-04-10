// client/src/components/BacktestTradeCard.jsx
// ── PNTHR Backtest Trade Card — Modal overlay for backtest year trades ────────
// Reuses the visual pattern from ClosedTradeCards but replaces discipline
// scoring with per-lot pyramid math breakdown and friction analysis.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import ClosedTradeChartModal from './ClosedTradeChartModal';

const LOT_NAMES = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
const LOT_PCT   = [0.35, 0.25, 0.20, 0.12, 0.08];

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return '—';
  return `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}/${dt.getUTCFullYear()}`;
}

function fmtDollar(n) {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Transform backtest trade → ClosedTradeChartModal format ─────────────────
function toChartEntry(t) {
  const isLong = t.signal === 'BL';
  const dir = isLong ? 'LONG' : 'SHORT';
  const lots = (t.lots || []).map(l => ({
    price: l.fillPrice,
    shares: l.shares,
    date: l.fillDate,
  }));
  const exitDate = t.exitDate || null;
  const exitPrice = t.exitPrice || 0;
  return {
    _id: t._id || t.tradeId,
    ticker: t.ticker,
    direction: dir,
    sector: t.sector,
    lots,
    exits: exitDate ? [{ price: exitPrice, date: exitDate, reason: t.exitReason, isFinalExit: true }] : [],
    performance: {
      realizedPnlDollar: t.grossDollarPnl ?? 0,
      realizedPnlPct: t.grossProfitPct ?? null,
      avgExitPrice: exitPrice,
    },
    entry: {
      fillPrice: t.entryPrice,
      fillDate: t.entryDate,
      stopPrice: t.entryStop || 0,
      signalType: t.signal || (isLong ? 'BL' : 'SS'),
      killScore: t.killScore ?? null,
      killRank: t.killRank ?? null,
      killTier: t.entryTier ?? null,
    },
    lotTriggers: t.lotTriggers,
  };
}

// ── Main component ───────────────────────────────────────────────────────────
export default function BacktestTradeCard({ trade, allTrades, onClose }) {
  const [showChart, setShowChart] = useState(false);
  const backdropRef = useRef(null);

  const t = trade;
  if (!t) return null;

  const isLong = t.signal === 'BL';
  const dir = isLong ? 'LONG' : 'SHORT';
  const lots = Array.isArray(t.lots) ? t.lots : [];
  const triggers = Array.isArray(t.lotTriggers) ? t.lotTriggers : [];
  const exitPrice = t.exitPrice;
  const isClosed = exitPrice != null;

  // Use lotTriggers for fill prices (authoritative for backtest data)
  const lotsWithTriggers = lots.map((lot, i) => {
    const lotIdx = lot.lot ? (lot.lot - 1) : i;
    const triggerPrice = triggers[lotIdx] || lot.fillPrice;
    return { ...lot, triggerPrice };
  });

  // Compute per-lot P&L
  const lotPnLs = lotsWithTriggers.map(lot => {
    if (!isClosed || !lot.triggerPrice || !lot.shares) return { gross: 0, shares: 0, fillPrice: 0 };
    const gross = isLong
      ? (exitPrice - lot.triggerPrice) * lot.shares
      : (lot.triggerPrice - exitPrice) * lot.shares;
    return { gross: parseFloat(gross.toFixed(2)), shares: lot.shares, fillPrice: lot.triggerPrice };
  });

  const totalShares = lotPnLs.reduce((s, l) => s + l.shares, 0);
  const totalCost = lotsWithTriggers.reduce((s, l) => s + (l.triggerPrice || 0) * (l.shares || 0), 0);
  const avgCost = totalShares > 0 ? totalCost / totalShares : 0;
  const grossPnl = lotPnLs.reduce((s, l) => s + l.gross, 0);
  const friction = t.totalFrictionDollar || 0;
  const netPnl = parseFloat((grossPnl - friction).toFixed(2));

  // Friction per-lot breakdown (from stored lot data)
  const lotFriction = lots.map(lot => {
    const entryComm = lot.entryComm || 0;
    const exitComm = lot.exitComm || 0;
    const entrySlip = lot.entrySlip || 0;
    const exitSlip = lot.exitSlip || 0;
    const borrow = lot.borrowCost || 0;
    return { entryComm, exitComm, entrySlip, exitSlip, borrow, total: lot.totalLotFriction || (entryComm + exitComm + entrySlip + exitSlip + borrow) };
  });
  const totalComm = lotFriction.reduce((s, l) => s + l.entryComm + l.exitComm, 0);
  const totalSlip = lotFriction.reduce((s, l) => s + l.entrySlip + l.exitSlip, 0);
  const totalBorrow = lotFriction.reduce((s, l) => s + l.borrow, 0);

  // Chart data adapter
  const chartEntry = toChartEntry(t);
  const allChartEntries = (allTrades || []).map(toChartEntry);

  // Close on escape
  useEffect(() => {
    const handleKey = e => { if (e.key === 'Escape' && !showChart) onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, showChart]);

  const pnlColor = netPnl >= 0 ? '#6bcb77' : '#ff6b6b';
  const grossColor = grossPnl >= 0 ? '#6bcb77' : '#ff6b6b';

  return (
    <>
      {/* Backdrop */}
      <div
        ref={backdropRef}
        onClick={e => { if (e.target === backdropRef.current) onClose(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9000,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
          paddingTop: 60, overflowY: 'auto',
        }}
      >
        <div style={{
          background: '#111', border: '1px solid #333', borderRadius: 10,
          width: '90%', maxWidth: 820, marginBottom: 60,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}>

          {/* ── HEADER ── */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '14px 18px', background: 'rgba(212,160,23,0.07)',
            borderBottom: '1px solid #2a2a2a', borderRadius: '10px 10px 0 0',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: '#FFD700', fontSize: '1.4rem', fontWeight: 700 }}>{t.ticker}</span>
              <span style={{
                background: isLong ? 'rgba(40,167,69,0.25)' : 'rgba(220,53,69,0.25)',
                color: isLong ? '#28a745' : '#dc3545',
                padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700,
              }}>{dir}</span>
              <span style={{ color: '#777', fontSize: '0.8rem' }}>{fmtDate(t.entryDate)} → {fmtDate(t.exitDate || null)}</span>
              {t.sector && <span style={{ color: '#555', fontSize: '0.75rem' }}>{t.sector}</span>}
              {t.tradingDays != null && <span style={{ color: '#555', fontSize: '0.72rem' }}>{t.tradingDays}d</span>}
              {t.exitReason && (
                <span style={{
                  color: t.exitReason === 'SIGNAL' || t.exitReason === 'SIGNAL_BE' || t.exitReason === 'SIGNAL_SE'
                    ? '#6bcb77' : t.exitReason === 'FEAST' ? '#fcf000'
                    : t.exitReason === 'STOP_HIT' ? '#ff8c00' : '#888',
                  fontWeight: 700, fontSize: 10, letterSpacing: '0.05em',
                  background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: 4,
                }}>{t.exitReason}</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: pnlColor, fontSize: '1.1rem', fontWeight: 700 }}>{fmtDollar(netPnl)}</div>
                <div style={{ color: '#666', fontSize: '0.7rem' }}>NET P&L</div>
              </div>
              {/* Chart icon */}
              <span
                onClick={() => setShowChart(true)}
                title="View trade chart"
                style={{ fontSize: 14, cursor: 'pointer', color: '#555', padding: '2px 4px', borderRadius: 4, transition: 'color 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.color = '#FFD700'}
                onMouseLeave={e => e.currentTarget.style.color = '#555'}
              >📊</span>
              {/* Close button */}
              <span
                onClick={onClose}
                style={{ color: '#666', fontSize: '1.2rem', cursor: 'pointer', padding: '0 4px' }}
                onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                onMouseLeave={e => e.currentTarget.style.color = '#666'}
              >✕</span>
            </div>
          </div>

          {/* ── TRADE SUMMARY ── */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12,
            padding: '14px 18px', borderBottom: '1px solid #1e1e1e',
          }}>
            <DataCell label="ENTRY PRICE" value={`$${Number(t.entryPrice).toFixed(2)}`} />
            <DataCell label="EXIT PRICE" value={exitPrice != null ? `$${Number(exitPrice).toFixed(2)}` : '—'} />
            <DataCell label="AVG COST" value={`$${avgCost.toFixed(4)}`} color="#aaa" />
            <DataCell label="TOTAL SHARES" value={totalShares} />
            <DataCell label="LOTS FILLED" value={`${lots.length} of 5`} />
            <DataCell label="TRADING DAYS" value={t.tradingDays ?? '—'} />
            <DataCell label="KILL SCORE" value={t.killScore ?? '—'} color={t.killScore ? '#fcf000' : '#555'} />
            <DataCell label="TIER" value={t.entryTier ?? '—'} />
          </div>

          {/* ── PYRAMID LOT MATH ── */}
          <div style={{ padding: '14px 18px', borderBottom: '1px solid #1e1e1e' }}>
            <div style={{ color: '#fcf000', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 12 }}>
              PYRAMID LOT BREAKDOWN
            </div>

            {lotsWithTriggers.map((lot, i) => {
              const lotNum = lot.lot || (i + 1);
              const name = LOT_NAMES[lotNum - 1] || `Lot ${lotNum}`;
              const pnlData = lotPnLs[i];
              const fillPrice = lot.triggerPrice;
              const shares = lot.shares || 0;
              const priceDiff = isLong ? (exitPrice - fillPrice) : (fillPrice - exitPrice);
              const priceDiffStr = priceDiff >= 0
                ? `$${priceDiff.toFixed(2)}`
                : `-$${Math.abs(priceDiff).toFixed(2)}`;
              const lotGrossColor = pnlData.gross >= 0 ? '#6bcb77' : '#ff6b6b';
              const action = isLong ? 'Bought' : 'Shorted';
              const exitAction = isLong ? 'Sold' : 'Covered';
              const pctLabel = `${(LOT_PCT[lotNum - 1] * 100).toFixed(0)}%`;

              return (
                <div key={i} style={{
                  background: 'rgba(255,255,255,0.02)', border: '1px solid #222',
                  borderRadius: 6, padding: '10px 14px', marginBottom: 8,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ color: '#fcf000', fontWeight: 700, fontSize: 12, letterSpacing: '0.04em' }}>
                      LOT {lotNum} — {name} <span style={{ color: '#666', fontWeight: 400 }}>({pctLabel})</span>
                    </span>
                    <span style={{ color: lotGrossColor, fontWeight: 700, fontSize: 13 }}>
                      {fmtDollar(pnlData.gross)}
                    </span>
                  </div>
                  <div style={{ color: '#ccc', fontSize: 12, lineHeight: 1.7, fontFamily: 'monospace' }}>
                    <div>
                      {action} <span style={{ color: '#fff', fontWeight: 600 }}>{shares}</span> shares @ <span style={{ color: '#fff', fontWeight: 600 }}>${fillPrice.toFixed(2)}</span>
                      <span style={{ color: '#666' }}> &nbsp; {fmtDate(lot.fillDate)}</span>
                    </div>
                    {isClosed && (
                      <div>
                        {exitAction} @ <span style={{ color: '#fff', fontWeight: 600 }}>${exitPrice.toFixed(2)}</span>
                      </div>
                    )}
                    {isClosed && (
                      <div style={{ color: '#aaa' }}>
                        P&L: ({priceDiffStr}) x {shares} = <span style={{ color: lotGrossColor, fontWeight: 700 }}>{fmtDollar(pnlData.gross)}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Unfilled lots */}
            {triggers.length > lots.length && (
              <div style={{ marginTop: 4 }}>
                {triggers.slice(lots.length).map((trigger, i) => {
                  const lotNum = lots.length + i + 1;
                  const name = LOT_NAMES[lotNum - 1] || `Lot ${lotNum}`;
                  return (
                    <div key={lotNum} style={{
                      background: 'rgba(255,255,255,0.01)', border: '1px solid #1a1a1a',
                      borderRadius: 6, padding: '6px 14px', marginBottom: 4, opacity: 0.4,
                    }}>
                      <span style={{ color: '#fcf000', fontWeight: 700, fontSize: 11, letterSpacing: '0.04em' }}>
                        LOT {lotNum} — {name}
                      </span>
                      <span style={{ color: '#666', fontSize: 11, marginLeft: 12 }}>
                        Trigger: ${trigger.toFixed(2)} — not filled
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── P&L SUMMARY ── */}
          <div style={{ padding: '14px 18px', borderBottom: '1px solid #1e1e1e' }}>
            <div style={{ color: '#fcf000', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 10 }}>
              P&L SUMMARY
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
              gap: 12, fontFamily: 'monospace', fontSize: 13,
            }}>
              <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid #222', borderRadius: 6, padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ color: '#888', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 4 }}>GROSS P&L</div>
                <div style={{ color: grossColor, fontWeight: 700, fontSize: 16 }}>{fmtDollar(grossPnl)}</div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid #222', borderRadius: 6, padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ color: '#888', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 4 }}>FRICTION</div>
                <div style={{ color: '#ff8c00', fontWeight: 700, fontSize: 16 }}>-${friction.toFixed(2)}</div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid #222', borderRadius: 6, padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ color: '#888', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 4 }}>NET P&L</div>
                <div style={{ color: pnlColor, fontWeight: 700, fontSize: 16 }}>{fmtDollar(netPnl)}</div>
              </div>
            </div>
          </div>

          {/* ── FRICTION BREAKDOWN ── */}
          <div style={{ padding: '14px 18px' }}>
            <div style={{ color: '#888', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 8 }}>
              FRICTION BREAKDOWN
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
              fontSize: 12, color: '#aaa',
            }}>
              <div>
                <span style={{ color: '#666' }}>Commissions: </span>
                <span style={{ color: '#ccc' }}>${totalComm.toFixed(2)}</span>
              </div>
              <div>
                <span style={{ color: '#666' }}>Slippage: </span>
                <span style={{ color: '#ccc' }}>${totalSlip.toFixed(2)}</span>
              </div>
              <div>
                <span style={{ color: '#666' }}>Borrow cost: </span>
                <span style={{ color: '#ccc' }}>${totalBorrow.toFixed(2)}</span>
              </div>
            </div>
            <div style={{ color: '#555', fontSize: 10, marginTop: 6 }}>
              IBKR Pro Fixed: $0.005/shr, $1 min, 1% cap &nbsp;|&nbsp; Slippage: 5bps/leg &nbsp;|&nbsp; Borrow: sector-tiered annualized
            </div>
          </div>

        </div>
      </div>

      {/* ── Chart Modal — z-index must be above the card backdrop (9000) ── */}
      {showChart && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9500 }}>
          <ClosedTradeChartModal
            entry={chartEntry}
            allEntries={allChartEntries}
            onClose={() => setShowChart(false)}
          />
        </div>
      )}
    </>
  );
}

// ── DataCell helper ──────────────────────────────────────────────────────────
function DataCell({ label, value, color }) {
  return (
    <div>
      <div style={{ color: '#666', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
      <div style={{ color: color || '#ccc', fontSize: 14, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
