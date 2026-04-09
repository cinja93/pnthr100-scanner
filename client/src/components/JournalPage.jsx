// client/src/components/JournalPage.jsx
// ── PNTHR Journal — Trade analysis, discipline tracking, pattern recognition ──

import React, { useState, useEffect, useMemo, Component } from 'react';
import { API_BASE, authHeaders } from '../services/api';
import { useAuth } from '../AuthContext';
import { useDemo } from '../contexts/DemoContext';
import ScorecardGrid from './ScorecardGrid';
import ClosedTradeCards from './ClosedTradeCards';
import GrowthChart from './GrowthChart';
import InvestorCalculator from './InvestorCalculator';
import pantherHead from '../assets/panther head.png';

class TradeDetailBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(err) { return { error: err }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#1a0a0a', border: '1px solid #7b2e2e', borderRadius: 6, padding: '12px 16px', margin: '4px 0' }}>
          <div style={{ color: '#dc3545', fontWeight: 700, fontSize: 12, marginBottom: 4 }}>⚠ Could not render trade detail</div>
          <div style={{ color: '#666', fontSize: 11 }}>{this.state.error?.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

const DISC_COLORS = (score) => {
  if (score == null) return '#555';
  if (score >= 90) return '#6bcb77';  // ELITE
  if (score >= 75) return '#FFD700';  // STRONG
  if (score >= 60) return '#fd7e14';  // MODERATE
  if (score >= 40) return '#dc3545';  // WEAK
  return '#8b0000';                    // SYSTEM OVERRIDE
};

// Tier background color based on % of max achieved
const tierBg = (total, max) => {
  if (!max) return 'rgba(255,255,255,0.03)';
  const pct = total / max;
  if (pct >= 0.90) return 'rgba(107,203,119,0.10)';
  if (pct >= 0.70) return 'rgba(255,215,0,0.08)';
  if (pct >= 0.50) return 'rgba(253,126,20,0.09)';
  return 'rgba(220,53,69,0.10)';
};
const tierBorder = (total, max) => {
  if (!max) return '#2a2a2a';
  const pct = total / max;
  if (pct >= 0.90) return 'rgba(107,203,119,0.25)';
  if (pct >= 0.70) return 'rgba(255,215,0,0.20)';
  if (pct >= 0.50) return 'rgba(253,126,20,0.22)';
  return 'rgba(220,53,69,0.22)';
};

const REASON_COLORS = {
  SIGNAL: '#6bcb77',
  FEAST: '#FFD700',
  STOP_HIT: '#ff8c00',
  STALE_HUNT: '#ff8c00',
  MANUAL: '#dc3545',
};

const SUGGESTED_TAGS = ['kill-top-10', 'earnings-play', 'sector-rotation', 'breakout', 'mean-reversion', 'scalp'];

// ── DisciplineCheck — one row of the checklist ───────────────────────────────
function DisciplineCheck({ passed, na, label, detail }) {
  const icon  = na ? '—' : passed ? '✓' : '✗';
  const color = na ? '#444' : passed ? '#6bcb77' : '#ff6b6b';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', borderBottom: '1px solid #111' }}>
      <span style={{ color, fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0, fontWeight: 700 }}>{icon}</span>
      <span style={{ color: na ? '#555' : '#ccc', fontSize: 11, flex: 1 }}>{label}</span>
      <span style={{ color: '#555', fontSize: 10, textAlign: 'right' }}>{detail}</span>
    </div>
  );
}

// ── TradeDetail — defined OUTSIDE JournalPage to prevent remount on every keystroke ──
function TradeDetail({ entry, noteInputs, setNoteInputs, addNote, deleteNote, addTag, removeTag }) {
  const disc = entry.discipline;
  const eb   = disc?.entryBreakdown || {};
  const hb   = disc?.holdBreakdown  || {};
  const xb   = disc?.exitBreakdown  || {};
  const exits = entry.exits || [];
  const finalExit = exits.find(e => e.isFinalExit) || exits[exits.length - 1];
  const mkt = finalExit?.marketAtExit;
  const isClosed = entry.performance?.status === 'CLOSED';

  // Derive human-readable discipline check values from breakdown scores
  const checks = {
    confirmedSignal: eb.confirmedSignal != null ? { passed: eb.confirmedSignal >= 10, detail: entry.entry?.killRank ? `Kill #${entry.entry.killRank} · ${entry.entry.killTier || ''}` : 'No PNTHR signal at entry' } : null,
    entryTiming:     eb.entryTiming    != null ? { passed: eb.entryTiming >= 10,     detail: eb.entryTiming >= 10 ? 'Within 1 week of signal' : 'Late entry' }                      : null,
    slippage:        eb.slippage       != null ? { passed: eb.slippage >= 3,          detail: 'Fill vs signal price' }                                                                 : null,
    sizing:          eb.sizingAdherence != null ? { passed: eb.sizingAdherence >= 5,  detail: `${entry.totalFilledShares || '—'} shares filled` }                                     : null,
    heldDrawdown:    hb.heldThroughDrawdown != null ? { passed: hb.heldThroughDrawdown >= 10, detail: 'No panic exit on drawdown' }                                                    : null,
    pyramiding:      hb.pyramidingFollowed  != null ? { passed: hb.pyramidingFollowed >= 10,  detail: `${(entry.lots || []).length} lot${(entry.lots || []).length !== 1 ? 's' : ''} filled` } : null,
    stopMaintained:  hb.stopMaintained      != null ? { passed: hb.stopMaintained >= 10,      detail: `Stop $${entry.entry?.stopPrice?.toFixed(2) || '—'}` }                          : null,
    followedSignal:  xb.followedSignal  != null ? { passed: xb.followedSignal >= 16,  detail: exits.map(e => e.reason).join(', ') || '—' }                                             : null,
    feastFollowed:   xb.feastFollowed   != null ? { passed: xb.feastFollowed >= 10,   na: !exits.some(e => e.reason === 'FEAST'), detail: exits.some(e => e.reason === 'FEAST') ? 'FEAST rule executed' : 'N/A — RSI never triggered' } : null,
    staleHunt:       xb.staleHuntFollowed != null ? { na: true, detail: (entry.performance?.holdingDays || 0) < 20 ? 'N/A — closed before day 20' : 'Timer respected' }               : null,
    exitSlippage:    xb.exitSlippage    != null ? { passed: xb.exitSlippage >= 3,     detail: 'Exit price vs stop/signal' }                                                             : null,
  };
  const hasChecks = Object.values(checks).some(c => c !== null);

  const NOTE_TYPE_COLORS = { EXIT: '#ff8c00', OVERRIDE: '#dc3545', MID_TRADE: '#888', ENTRY: '#6bcb77' };
  const sectionHdr = (label) => (
    <div style={{ color: '#555', fontSize: 9, letterSpacing: 2, fontWeight: 700, marginBottom: 6, marginTop: 14, textTransform: 'uppercase' }}>{label}</div>
  );

  return (
    <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: 8, padding: 16, marginTop: 2 }}>

      {/* ── Entry + Lots ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 4, flexWrap: 'wrap' }}>
        <div>
          {sectionHdr('Entry')}
          <div style={{ fontSize: 12, color: '#ccc' }}>
            Filled: {entry.entry?.fillDate || '—'} @ ${entry.entry?.fillPrice?.toFixed(2) || '—'}
          </div>
          {entry.entry?.stopPrice && <div style={{ fontSize: 11, color: '#888' }}>Stop: ${entry.entry.stopPrice.toFixed(2)}</div>}
          {entry.entry?.killRank
            ? <div style={{ fontSize: 11, color: '#FFD700' }}>Kill #{entry.entry.killRank} — {entry.entry.killTier}</div>
            : <div style={{ fontSize: 11, color: '#555' }}>No PNTHR signal</div>}
        </div>
        <div>
          {sectionHdr('Lots Filled')}
          {(entry.lots || []).map(lot => (
            <div key={lot.lot} style={{ fontSize: 11, color: '#ccc' }}>
              #{lot.lot} · {lot.shares} shr @ ${lot.price?.toFixed(2)} · {lot.date}
            </div>
          ))}
          {(entry.lots || []).length === 0 && <div style={{ fontSize: 11, color: '#444' }}>No lots recorded</div>}
        </div>
      </div>

      {/* ── Exits ─────────────────────────────────────────────────────────── */}
      {exits.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          {sectionHdr('Exits')}
          {exits.map(ex => (
            <div key={ex.id}>
              <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#ccc', padding: '3px 0', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: '#444', minWidth: 24 }}>{ex.id}</span>
                <span>{ex.shares} shr @ ${ex.price?.toFixed(2)}</span>
                <span style={{ color: '#333' }}>·</span>
                <span style={{ color: '#888' }}>{ex.date}</span>
                <span style={{ color: REASON_COLORS[ex.reason] || '#888', fontWeight: 700 }}>{ex.reason}{ex.isOverride ? ' ⚠' : ''}</span>
                <span style={{ color: (ex.pnl?.dollar ?? 0) >= 0 ? '#6bcb77' : '#ff6b6b', marginLeft: 'auto' }}>
                  {(ex.pnl?.dollar ?? 0) >= 0 ? '+' : ''}${ex.pnl?.dollar?.toFixed(2)} ({(ex.pnl?.pct ?? 0) >= 0 ? '+' : ''}{ex.pnl?.pct?.toFixed(1)}%)
                </span>
              </div>
              {ex.note && (
                <div style={{ fontSize: 11, color: '#888', padding: '2px 0 4px 28px', fontStyle: 'italic' }}>"{ex.note}"</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Discipline Score v2 — 3-Tier Breakdown ───────────────────────── */}
      {disc?.totalScore != null && disc?.tier1 ? (
        <div style={{ marginTop: 12, marginBottom: 4 }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
            <span style={{ color: '#555', fontSize: 9, letterSpacing: 2, fontWeight: 700 }}>DISCIPLINE SCORE</span>
            <span style={{ color: DISC_COLORS(disc.totalScore), fontSize: 24, fontWeight: 900 }}>{disc.totalScore}/100</span>
            <span style={{ color: DISC_COLORS(disc.totalScore), fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{disc.tierLabel}</span>
            {(disc.overrideCount || 0) > 0 && <span style={{ color: '#dc3545', fontSize: 10 }}>⚠ {disc.overrideCount} override{disc.overrideCount > 1 ? 's' : ''}</span>}
          </div>
          {/* Tier cards */}
          {[disc.tier1, disc.tier2, disc.tier3].map(tier => (
            <div key={tier.label} style={{ background: tierBg(tier.total, tier.max), border: `1px solid ${tierBorder(tier.total, tier.max)}`, borderRadius: 6, padding: '8px 10px', marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                <span style={{ color: '#888', fontSize: 9, fontWeight: 700, letterSpacing: 1 }}>{tier.label}</span>
                <span style={{ color: DISC_COLORS(Math.round((tier.total / tier.max) * 100)), fontSize: 11, fontWeight: 700 }}>{tier.total}/{tier.max}</span>
              </div>
              {Object.entries(tier.components).map(([key, c]) => (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11 }}>
                  <span style={{ color: '#aaa', flex: 1 }}>{c.detail}</span>
                  <span style={{ color: c.score === c.max ? '#6bcb77' : c.score === 0 ? '#dc3545' : '#fd7e14', fontWeight: 700, marginLeft: 8, whiteSpace: 'nowrap' }}>
                    {c.score}/{c.max} <span style={{ color: '#555', fontWeight: 400, fontSize: 10 }}>{c.label}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: '#444', fontSize: 11, marginTop: 8 }}>
          {isClosed ? 'Discipline score: calculating…' : 'Discipline score: pending close'}
        </div>
      )}

      {/* ── Ghost Comparison ──────────────────────────────────────────────── */}
      {entry.whatIf?.signalExitDate && (disc?.overrideCount || 0) > 0 && (
        <div style={{ background: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.2)', borderRadius: 6, padding: '10px 14px', marginTop: 12, marginBottom: 4 }}>
          <div style={{ color: '#dc3545', fontSize: 10, letterSpacing: 1, fontWeight: 700, marginBottom: 4 }}>WHAT IF — GHOST COMPARISON</div>
          <div style={{ fontSize: 11, color: '#ccc' }}>
            If held to SIGNAL exit ({entry.whatIf.signalExitDate} @ ${entry.whatIf.signalExitPrice?.toFixed(2)}):&nbsp;
            <span style={{ color: (entry.whatIf.signalExitPnl || 0) >= 0 ? '#6bcb77' : '#ff6b6b' }}>
              {(entry.whatIf.signalExitPnl || 0) >= 0 ? '+' : ''}{entry.whatIf.signalExitPnl?.toFixed(1)}%
            </span>
          </div>
          {entry.whatIf.overrideCostDollar != null && (
            <div style={{ fontSize: 11, color: '#ff8c00', marginTop: 4 }}>
              Cost of override: {entry.whatIf.overrideCostDollar >= 0 ? '+' : ''}${entry.whatIf.overrideCostDollar?.toFixed(2)} left on table
            </div>
          )}
        </div>
      )}

      {/* ── Market + Sector Conditions (entry and/or exit) ────────────────── */}
      {(() => {
        const entryMkt = entry.entry?.marketAtEntry;
        const entrySec = entry.entry?.sectorAtEntry;
        const hasEntry = entryMkt && (entryMkt.spyPrice || entryMkt.qqqPrice);
        const hasExit  = mkt && (mkt.spyPrice || mkt.qqqPrice);
        if (!hasEntry && !hasExit) return null;

        const SnapRow = ({ snap, sec }) => (
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#aaa', flexWrap: 'wrap', alignItems: 'center' }}>
            {snap.spyPrice && (
              <span>SPY <span style={{ color: '#fff', fontWeight: 700 }}>${snap.spyPrice.toFixed(2)}</span>
                {snap.spyVsEma != null
                  ? <span style={{ color: snap.spyPosition === 'above' ? '#6bcb77' : '#ff6b6b', marginLeft: 4 }}>
                      {snap.spyVsEma >= 0 ? '+' : ''}{snap.spyVsEma.toFixed(1)}% EMA
                    </span>
                  : snap.spyChange1D != null &&
                    <span style={{ color: snap.spyChange1D >= 0 ? '#6bcb77' : '#ff6b6b', marginLeft: 4 }}>
                      {snap.spyChange1D >= 0 ? '▲' : '▼'}{Math.abs(snap.spyChange1D).toFixed(1)}%
                    </span>
                }
              </span>
            )}
            {snap.qqqPrice && (
              <span>QQQ <span style={{ color: '#fff', fontWeight: 700 }}>${snap.qqqPrice.toFixed(2)}</span>
                {snap.qqqVsEma != null
                  ? <span style={{ color: snap.qqqPosition === 'above' ? '#6bcb77' : '#ff6b6b', marginLeft: 4 }}>
                      {snap.qqqVsEma >= 0 ? '+' : ''}{snap.qqqVsEma.toFixed(1)}% EMA
                    </span>
                  : snap.qqqChange1D != null &&
                    <span style={{ color: snap.qqqChange1D >= 0 ? '#6bcb77' : '#ff6b6b', marginLeft: 4 }}>
                      {snap.qqqChange1D >= 0 ? '▲' : '▼'}{Math.abs(snap.qqqChange1D).toFixed(1)}%
                    </span>
                }
              </span>
            )}
            {snap.vix != null && (
              <span>VIX <span style={{ color: snap.vix >= 25 ? '#ff6b6b' : snap.vix >= 18 ? '#ff8c00' : '#aaa', fontWeight: 700 }}>{snap.vix.toFixed(1)}</span></span>
            )}
            {snap.regime && (() => {
              const regimeLabel = typeof snap.regime === 'object' ? (snap.regime?.label ?? '') : snap.regime;
              return (
                <span style={{
                  background: regimeLabel === 'BULLISH' ? 'rgba(107,203,119,0.12)' : regimeLabel === 'BEARISH' ? 'rgba(255,107,107,0.12)' : 'rgba(255,140,0,0.12)',
                  color: regimeLabel === 'BULLISH' ? '#6bcb77' : regimeLabel === 'BEARISH' ? '#ff6b6b' : '#ff8c00',
                  fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4, letterSpacing: 1,
                }}>{regimeLabel}</span>
              );
            })()}
            {sec?.etfTicker && sec.etfPrice != null && (
              <span style={{ color: '#555', borderLeft: '1px solid #1a1a1a', paddingLeft: 12 }}>
                {sec.etfTicker} <span style={{ color: '#aaa', fontWeight: 700 }}>${sec.etfPrice.toFixed(2)}</span>
                {sec.etfChange1D != null && (
                  <span style={{ color: sec.etfChange1D >= 0 ? '#6bcb77' : '#ff6b6b', marginLeft: 4 }}>
                    {sec.etfChange1D >= 0 ? '▲' : '▼'}{Math.abs(sec.etfChange1D).toFixed(1)}%
                  </span>
                )}
              </span>
            )}
          </div>
        );

        return (
          <div style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 6, padding: '10px 12px', marginTop: 12, marginBottom: 4 }}>
            {sectionHdr('Market Conditions')}
            {hasEntry && (
              <>
                {hasExit && <div style={{ color: '#444', fontSize: 9, letterSpacing: 1, marginBottom: 3 }}>AT ENTRY</div>}
                <SnapRow snap={entryMkt} sec={entrySec} />
              </>
            )}
            {hasExit && (
              <>
                {hasEntry && <div style={{ color: '#444', fontSize: 9, letterSpacing: 1, marginTop: 8, marginBottom: 3 }}>AT EXIT</div>}
                <SnapRow snap={mkt} sec={null} />
              </>
            )}
          </div>
        );
      })()}

      {/* ── Wash Sale ─────────────────────────────────────────────────────── */}
      {(entry.washSale?.isLoss || entry.washRule?.isLoss) && (() => {
        const ws = entry.washSale?.isLoss ? entry.washSale : entry.washRule;
        const expiry = ws.expiryDate ? new Date(ws.expiryDate) : null;
        const now = new Date();
        // Normalize both to UTC midnight for calendar-day counting
        // (avoids time-of-day artifacts when exit was recorded mid-afternoon)
        const expiryDay = expiry ? new Date(expiry.toISOString().split('T')[0] + 'T00:00:00.000Z') : null;
        const todayDay  = new Date(now.toISOString().split('T')[0] + 'T00:00:00.000Z');
        const daysLeft  = expiryDay ? Math.max(0, Math.round((expiryDay - todayDay) / 86400000)) : null;
        // Use UTC date parts to avoid timezone shift (midnight UTC shows as prior day in ET)
        const fmtD = (d) => {
          if (!d) return '—';
          const dt = new Date(d);
          return `${String(dt.getUTCMonth()+1).padStart(2,'0')}/${String(dt.getUTCDate()).padStart(2,'0')}/${dt.getUTCFullYear()}`;
        };
        const isTriggered = ws.triggered;
        const isExpired = expiry && expiry <= now && !isTriggered;
        const lossAmt = Math.abs(ws.lossAmount ?? entry.performance?.realizedPnlDollar ?? 0);
        return (
          <div style={{ borderLeft: '3px solid #dc3545', borderRadius: '0 6px 6px 0', background: isTriggered ? 'rgba(220,53,69,0.1)' : 'rgba(220,53,69,0.04)', padding: '10px 14px', marginTop: 12, marginBottom: 4 }}>
            <div style={{ color: '#dc3545', fontWeight: 800, fontSize: 12, marginBottom: 5 }}>
              {isTriggered ? '⚠ WASH SALE TRIGGERED' : isExpired ? '✓ WASH WINDOW CLEARED' : `⚠ WASH WINDOW ACTIVE — ${daysLeft}d remaining`}
            </div>
            {isTriggered
              ? <div style={{ fontSize: 11, color: '#ccc', lineHeight: 1.7 }}>
                  Triggered{ws.triggeredDate ? ` on ${fmtD(ws.triggeredDate)}` : ''} — new {entry.ticker} position opened during wash window.<br/>
                  <span style={{ color: '#dc3545' }}>-${lossAmt.toFixed(2)} loss is disallowed for tax purposes.</span>
                </div>
              : isExpired
                ? <div style={{ fontSize: 11, color: '#6bcb77' }}>
                    Window {fmtD(ws.exitDate)} → {fmtD(ws.expiryDate)} expired without re-entry. Loss is claimable.
                  </div>
                : <div style={{ fontSize: 11, color: '#ccc', lineHeight: 1.7 }}>
                    Window: {fmtD(ws.exitDate)} → {fmtD(ws.expiryDate)}<br/>
                    Do NOT re-enter <b style={{ color: '#fff' }}>{entry.ticker}</b> before <b style={{ color: '#FFD700' }}>{fmtD(ws.expiryDate)}</b> or -${lossAmt.toFixed(2)} loss will be disallowed.
                  </div>
            }
          </div>
        );
      })()}

      {/* ── Notes ─────────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 14, marginBottom: 12 }}>
        {sectionHdr('Notes')}
        {(entry.notes || []).length === 0 && <div style={{ color: '#333', fontSize: 11 }}>No notes yet.</div>}
        {(entry.notes || []).map(note => (
          <div key={note.id} style={{ padding: '6px 0', borderBottom: '1px solid #111' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
              <span style={{ color: '#444', fontSize: 10 }}>{note.timestamp ? new Date(note.timestamp).toLocaleString() : ''}</span>
              <span style={{
                background: '#111', color: NOTE_TYPE_COLORS[note.type] || '#888',
                fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700,
              }}>{note.type}</span>
              <button onClick={() => deleteNote(entry._id, note.id)}
                style={{ background: 'none', border: 'none', color: '#333', cursor: 'pointer', fontSize: 11, marginLeft: 'auto' }}>✕</button>
            </div>
            <div style={{ color: '#ccc', fontSize: 12, lineHeight: 1.5 }}>{note.text}</div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            value={noteInputs[entry._id] || ''}
            onChange={e => setNoteInputs(p => ({ ...p, [entry._id]: e.target.value }))}
            placeholder="Add a note..."
            style={{ flex: 1, background: '#111', border: '1px solid #222', color: '#fff', borderRadius: 4, padding: '5px 8px', fontSize: 12 }}
          />
          <button onClick={() => addNote(entry._id, 'MID_TRADE')}
            style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 4, padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            ADD
          </button>
        </div>
      </div>

      {/* ── Tags ──────────────────────────────────────────────────────────── */}
      <div>
        {sectionHdr('Tags')}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {(entry.tags || []).map(tag => (
            <span key={tag} style={{ background: '#111', border: '1px solid #222', color: '#aaa', fontSize: 10, padding: '2px 8px', borderRadius: 4, display: 'flex', gap: 4, alignItems: 'center' }}>
              {tag}
              <button onClick={() => removeTag(entry._id, tag)}
                style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', padding: 0, fontSize: 10 }}>✕</button>
            </span>
          ))}
          {SUGGESTED_TAGS.filter(t => !(entry.tags || []).includes(t)).slice(0, 4).map(t => (
            <button key={t} onClick={() => addTag(entry._id, t)}
              style={{ background: 'none', border: '1px dashed #222', color: '#444', fontSize: 9, padding: '2px 6px', borderRadius: 4, cursor: 'pointer' }}>
              + {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── HoverTooltip ──────────────────────────────────────────────────────────────
function HoverTooltip({ children, lines }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 999,
          background: '#1a1a1a', border: '1px solid #444', borderRadius: 7,
          padding: '10px 14px', minWidth: 260, maxWidth: 320,
          boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
          pointerEvents: 'none',
        }}>
          {lines.map((line, i) => (
            <div key={i} style={{
              fontSize: 11, lineHeight: 1.55,
              color: line.startsWith('WHEN') ? '#FFD700' : line.startsWith('•') ? '#ccc' : '#888',
              fontWeight: line.startsWith('WHEN') ? 700 : 400,
              marginBottom: i < lines.length - 1 ? 4 : 0,
            }}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function JournalPage({ onNavigate, initialFilter, focusPositionId, focusTicker }) {
  const { isAdmin } = useAuth();
  const { isDemo } = useDemo();
  const [tab, setTab] = useState('trades');
  const [fundPeriod, setFundPeriod] = useState('full_backtest'); // 'full_backtest' = 5 years, 'live_fund' = PNTHR 6-16-25
  const [entries, setEntries] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [weeklyReviews, setWeeklyReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState(initialFilter || 'ALL');
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState(-1);
  const [expandedId, setExpandedId] = useState(null);
  const [noteInputs, setNoteInputs] = useState({});
  const [weeklyReflection, setWeeklyReflection] = useState('');
  const [savingReview, setSavingReview] = useState(false);
  const [migrating,  setMigrating]  = useState(false);
  const [migrateResult, setMigrateResult] = useState(null);
  const [rescoring,  setRescoring]  = useState(false);
  const [rescoreResult, setRescoreResult] = useState(null);
  const [ibkrRepairing, setIbkrRepairing] = useState(false);
  const [ibkrRepairResult, setIbkrRepairResult] = useState(null);
  const [washRules, setWashRules] = useState([]);
  const [ratios, setRatios] = useState(null);
  const [dayTrades, setDayTrades] = useState([]);
  const [dayTradesLoading, setDayTradesLoading] = useState(false);
  const [archiveTab, setArchiveTab] = useState('test_system'); // 'test_system' = default, '2019', '2020', etc.
  const [backtestYears, setBacktestYears] = useState([]); // [{year, count}]
  const [backtestTrades, setBacktestTrades] = useState([]);
  const [backtestSummary, setBacktestSummary] = useState(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [testSystemTrades, setTestSystemTrades] = useState([]);
  const [testSystemLoading, setTestSystemLoading] = useState(false);
  const [showBacktestMetrics, setShowBacktestMetrics] = useState(false);
  const [systemTrades, setSystemTrades] = useState([]); // fromQueue trades for current year tab
  const [systemTradesLoading, setSystemTradesLoading] = useState(false);
  const [growthChartYear, setGrowthChartYear] = useState(null); // null=hidden, 'all'=cumulative, '2019'-'2026'=per year
  const [monthlyReturns, setMonthlyReturns] = useState(null);
  const [hurdleRates, setHurdleRates] = useState({});
  const [showCalculator, setShowCalculator] = useState(false);

  const fetchData = async (period) => {
    setLoading(true);
    const fp = period !== undefined ? period : fundPeriod;
    // Only pass fundPeriod filter when in demo mode
    const fpParam = (isDemo && fp) ? `fundPeriod=${fp}` : '';
    try {
      const [entriesRes, analyticsRes, reviewsRes, ratiosRes] = await Promise.all([
        fetch(`${API_BASE}/api/journal${fpParam ? `?${fpParam}` : ''}`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/journal/analytics${fpParam ? `?${fpParam}` : ''}`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/journal/weekly-reviews`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/portfolio/ratios${fpParam ? `?${fpParam}` : ''}`, { headers: authHeaders() }),
      ]);
      if (entriesRes.ok) setEntries(await entriesRes.json());
      if (analyticsRes.ok) setAnalytics(await analyticsRes.json());
      if (reviewsRes.ok) setWeeklyReviews(await reviewsRes.json());
      if (ratiosRes.ok) setRatios(await ratiosRes.json());
      else setRatios({ unavailable: true });
    } catch (e) { console.error('[JOURNAL]', e); setRatios({ unavailable: true }); }
    setLoading(false);
  };

  // Fetch on mount and when fundPeriod changes
  useEffect(() => { fetchData(fundPeriod); }, [fundPeriod]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch active wash rules when analytics tab is loaded
  useEffect(() => {
    if (tab !== 'analytics') return;
    const fpParam = (isDemo && fundPeriod) ? `?fundPeriod=${fundPeriod}` : '';
    fetch(`${API_BASE}/api/wash-rules${fpParam}`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : []).then(setWashRules).catch(() => {});
  }, [tab, fundPeriod]);

  // Fetch day trades when day-trades tab is loaded
  useEffect(() => {
    if (tab !== 'dayTrades') return;
    setDayTradesLoading(true);
    fetch(`${API_BASE}/api/journal/day-trades`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(d => { setDayTrades(d); setDayTradesLoading(false); })
      .catch(() => setDayTradesLoading(false));
  }, [tab]);

  // Fetch available backtest years on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/journal/backtest/years`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { if (Array.isArray(data)) setBacktestYears(data); })
      .catch(err => console.error('[JOURNAL] backtest years fetch error:', err));
  }, []);

  // Fetch backtest trades when a year tab is selected
  useEffect(() => {
    if (!archiveTab || archiveTab === 'test_system') return;
    setBacktestLoading(true);
    setBacktestTrades([]);
    setBacktestSummary(null);
    fetch(`${API_BASE}/api/journal/backtest/${archiveTab}`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        setBacktestTrades(Array.isArray(data.trades) ? data.trades : []);
        setBacktestSummary(data.summary || null);
        setBacktestLoading(false);
      }).catch(err => { console.error('[JOURNAL] backtest fetch error:', err); setBacktestLoading(false); });
  }, [archiveTab]);

  // Fetch test system trades when that tab is selected
  useEffect(() => {
    if (archiveTab !== 'test_system') return;
    setTestSystemLoading(true);
    setTestSystemTrades([]);
    fetch(`${API_BASE}/api/journal/test-system`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        setTestSystemTrades(Array.isArray(data) ? data : []);
        setTestSystemLoading(false);
      }).catch(err => { console.error('[JOURNAL] test-system fetch error:', err); setTestSystemLoading(false); });
  }, [archiveTab]);

  // Fetch real system trades (fromQueue) for current year tab (2026 only for now)
  useEffect(() => {
    const currentYear = new Date().getFullYear().toString();
    if (!archiveTab || archiveTab === 'test_system' || archiveTab !== currentYear) {
      setSystemTrades([]);
      return;
    }
    setSystemTradesLoading(true);
    fetch(`${API_BASE}/api/journal/system-trades/${archiveTab}`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        setSystemTrades(Array.isArray(data) ? data : []);
        setSystemTradesLoading(false);
      }).catch(err => { console.error('[JOURNAL] system-trades fetch error:', err); setSystemTradesLoading(false); });
  }, [archiveTab]);

  // Fetch monthly returns for growth charts
  useEffect(() => {
    if (!growthChartYear) return;
    if (monthlyReturns) return; // already fetched
    fetch(`${API_BASE}/api/journal/backtest/monthly-returns`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); })
      .then(data => {
        setMonthlyReturns(data.monthlyReturns || []);
        setHurdleRates(data.hurdleRates || {});
      })
      .catch(err => console.error('[JOURNAL] monthly-returns fetch error:', err));
  }, [growthChartYear, monthlyReturns]);

  const filtered = entries.filter(e => {
    if (filterStatus === 'ALL') return true;
    if (filterStatus === 'ACTIVE') return e.performance?.status === 'ACTIVE';
    if (filterStatus === 'PARTIAL') return e.performance?.status === 'PARTIAL';
    if (filterStatus === 'CLOSED') return e.performance?.status === 'CLOSED';
    if (filterStatus === 'OVERRIDES') return (e.discipline?.overrideCount || 0) > 0;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const av = sortField === 'createdAt' ? new Date(a.createdAt) : (a[sortField] ?? 0);
    const bv = sortField === 'createdAt' ? new Date(b.createdAt) : (b[sortField] ?? 0);
    return sortDir * (av < bv ? -1 : av > bv ? 1 : 0);
  });

  const handleSort = (field) => {
    if (sortField === field) setSortDir(d => -d);
    else { setSortField(field); setSortDir(-1); }
  };

  const addNote = async (entryId, type) => {
    const text = noteInputs[entryId];
    if (!text?.trim()) return;
    const res = await fetch(`${API_BASE}/api/journal/${entryId}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ type, text }),
    });
    if (res.ok) {
      setNoteInputs(p => ({ ...p, [entryId]: '' }));
      fetchData();
    }
  };

  const deleteNote = async (entryId, noteId) => {
    if (!confirm('Delete this note?')) return;
    await fetch(`${API_BASE}/api/journal/${entryId}/notes/${noteId}`, { method: 'DELETE', headers: authHeaders() });
    fetchData();
  };

  const addTag = async (entryId, tag) => {
    await fetch(`${API_BASE}/api/journal/${entryId}/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ tag }),
    });
    fetchData();
  };

  const removeTag = async (entryId, tag) => {
    await fetch(`${API_BASE}/api/journal/${entryId}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE', headers: authHeaders() });
    fetchData();
  };

  const getMondayOfCurrentWeek = () => {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d.toISOString().split('T')[0];
  };

  const runRescoreAll = async () => {
    if (!confirm('Rescore all closed trades? This will backfill missing signal/market data from Kill scores and regime, then recompute discipline scores.')) return;
    setRescoring(true);
    setRescoreResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/journal/rescore-all`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      setRescoreResult(data);
      if (data.success) fetchData();
    } catch (e) { setRescoreResult({ error: e.message }); }
    setRescoring(false);
  };

  const runIbkrRepair = async () => {
    if (!confirm('Repair IBKR journal entries?\n\nThis will:\n• Create journal entries for positions added directly (not via confirm flow)\n• Fix any direction/price mismatches from wrong position matches\n• Sync exit data for any trades missing it\n\nSafe to run multiple times.')) return;
    setIbkrRepairing(true);
    setIbkrRepairResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/journal/repair-ibkr`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      setIbkrRepairResult(data);
      if (data.repaired > 0) setTimeout(fetchData, 500);
    } catch (e) { setIbkrRepairResult({ error: e.message }); }
    setIbkrRepairing(false);
  };

  const runMigration = async () => {
    if (!confirm('Create journal entries for all existing positions that don\'t have one yet?')) return;
    setMigrating(true);
    setMigrateResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/journal/migrate`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      setMigrateResult(data);
      if (data.created > 0) fetchData();
    } catch (e) { setMigrateResult({ error: e.message }); }
    setMigrating(false);
  };

  const saveWeeklyReview = async () => {
    setSavingReview(true);
    const weekOf = getMondayOfCurrentWeek();
    await fetch(`${API_BASE}/api/journal/weekly-reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ weekOf, reflection: weeklyReflection }),
    });
    setSavingReview(false);
    fetchData();
  };

  const thStyle = (field) => ({
    color: sortField === field ? '#fcf000' : '#666',
    fontSize: 10, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', padding: '6px 8px',
    textAlign: 'left', borderBottom: '1px solid #222', whiteSpace: 'nowrap',
  });
  const tdStyle = { padding: '7px 8px', fontSize: 12, color: '#ccc', borderBottom: '1px solid #1a1a1a', verticalAlign: 'middle' };

  // Compute annual returns from journal entries
  const annualReturns = useMemo(() => {
    const closed = entries.filter(e => e.performance?.status === 'CLOSED');
    if (!closed.length) return [];
    // Group by exit year
    const yearPnl = {};
    for (const e of closed) {
      const yr = e.closedAt ? new Date(e.closedAt).getFullYear() : null;
      if (!yr) continue;
      yearPnl[yr] = (yearPnl[yr] || { pnl: 0, count: 0 });
      yearPnl[yr].pnl += (e.performance.totalPnlDollar || 0);
      yearPnl[yr].count++;
    }
    // Compute % return assuming compounding NAV
    const startingNav = fundPeriod === 'live_fund' ? 10_000_000 : 10_000_000;
    let runningNav = startingNav;
    const years = Object.keys(yearPnl).sort();
    return years.map(yr => {
      const pnl = yearPnl[yr].pnl;
      const pct = runningNav > 0 ? (pnl / runningNav * 100) : 0;
      runningNav += pnl;
      const currentYear = new Date().getFullYear();
      return { year: yr, pnl, pct: +pct.toFixed(1), count: yearPnl[yr].count, partial: +yr === currentYear };
    });
  }, [entries, fundPeriod]);

  const DisciplineStrip = () => {
    // Compute total return % from cumulative return in ratios
    const totalReturnPct = ratios?.cumulativeReturn != null
      ? (ratios.cumulativeReturn * 100).toFixed(1) : null;
    const sharpe = ratios?.current?.sharpe ?? ratios?.sinceInception?.sharpe;
    const sortino = ratios?.current?.sortino ?? ratios?.sinceInception?.sortino;

    // Demo mode: institutional metrics strip
    const demoCards = [
      { label: 'OVERALL SCORE', value: analytics?.avgDisciplineScore != null ? `${analytics.avgDisciplineScore}/100` : '—', color: analytics?.avgDisciplineScore != null ? DISC_COLORS(analytics.avgDisciplineScore) : '#555', sub: 'avg · last 20 trades' },
      { label: 'WIN RATE', value: analytics?.disciplineWinRate != null ? `${analytics.disciplineWinRate}%` : '—', color: '#6bcb77', sub: `${entries.filter(e => e.performance?.status === 'CLOSED').length} closed trades` },
      { label: 'TOTAL RETURN', value: totalReturnPct != null ? `${totalReturnPct > 0 ? '+' : ''}${totalReturnPct}%` : '—', color: totalReturnPct > 0 ? '#6bcb77' : totalReturnPct < 0 ? '#ff6b6b' : '#888', sub: `${ratios?.weeksOfData ?? 0} weeks` },
      { label: 'SHARPE', value: sharpe != null ? `${sharpe}` : '—', color: sharpe >= 2 ? '#6bcb77' : sharpe >= 1 ? '#FFD700' : '#ff8c00', sub: 'risk-adjusted return' },
      { label: 'SORTINO', value: sortino != null ? `${sortino}` : '—', color: sortino >= 3 ? '#6bcb77' : sortino >= 1.5 ? '#FFD700' : '#ff8c00', sub: 'downside risk-adjusted' },
    ];

    // Live trading: discipline-focused strip
    const liveCards = [
      { label: 'OVERALL SCORE', value: analytics?.avgDisciplineScore != null ? `${analytics.avgDisciplineScore}/100` : '0/100', color: analytics?.avgDisciplineScore != null ? DISC_COLORS(analytics.avgDisciplineScore) : '#555', sub: 'avg · last 20 trades' },
      { label: 'CLEAN STREAK', value: analytics?.streak != null ? `${analytics.streak}` : '0', color: '#6bcb77', sub: 'trades no overrides' },
      { label: 'OVERRIDES / MO', value: analytics?.overridesThisMonth != null ? String(analytics.overridesThisMonth) : '0', color: analytics?.overridesThisMonth > 0 ? '#ff8c00' : '#6bcb77', sub: 'this month' },
      { label: 'WIN RATE (DISC)', value: analytics?.disciplineWinRate != null ? `${analytics.disciplineWinRate}%` : 'No data', color: '#6bcb77', sub: 'score ≥ 75 (STRONG+)' },
      { label: 'WIN RATE (OVRD)', value: analytics?.overrideWinRate != null ? `${analytics.overrideWinRate}%` : 'No data', color: '#ff8c00', sub: 'override trades' },
    ];

    const cards = isDemo ? demoCards : liveCards;

    return (
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {cards.map(card => (
          <div key={card.label} style={{ background: '#111', borderRadius: 10, padding: '12px 18px', flex: '1 1 140px', minWidth: 120 }}>
            <div style={{ color: '#555', fontSize: 9, letterSpacing: 2, fontWeight: 700, marginBottom: 4 }}>{card.label}</div>
            <div style={{ color: card.color, fontSize: 22, fontWeight: 900 }}>{card.value}</div>
            {card.sub && <div style={{ color: '#444', fontSize: 9, marginTop: 2 }}>{card.sub}</div>}
          </div>
        ))}
        {/* Annual Returns card — demo only, wider */}
        {isDemo && annualReturns.length > 0 && (
          <div style={{ background: '#111', borderRadius: 10, padding: '12px 18px', flex: '2 1 320px', minWidth: 280 }}>
            <div style={{ color: '#555', fontSize: 9, letterSpacing: 2, fontWeight: 700, marginBottom: 8 }}>ANNUAL RETURNS</div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
              {annualReturns.map(yr => {
                const pnlAbs = Math.abs(yr.pnl);
                const pnlLabel = pnlAbs >= 1e6 ? `$${(yr.pnl / 1e6).toFixed(1)}M` : `$${Math.round(yr.pnl / 1e3).toLocaleString()}K`;
                return (
                  <div key={yr.year} style={{ textAlign: 'center', minWidth: 70 }}>
                    <div style={{ color: yr.pct >= 0 ? '#6bcb77' : '#ff6b6b', fontSize: 18, fontWeight: 900, lineHeight: 1 }}>
                      {yr.pct >= 0 ? '+' : ''}{yr.pct}%
                    </div>
                    <div style={{ color: yr.pnl >= 0 ? 'rgba(107,203,119,0.5)' : 'rgba(255,107,107,0.5)', fontSize: 9, marginTop: 1, fontWeight: 600 }}>
                      {yr.pnl >= 0 ? '+' : '-'}{pnlLabel}
                    </div>
                    <div style={{ color: '#444', fontSize: 8, marginTop: 1 }}>
                      {yr.year}{yr.partial ? '*' : ''} · {yr.count}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ color: '#333', fontSize: 8, marginTop: 4 }}>* partial year · compounded annually</div>
          </div>
        )}
      </div>
    );
  };

  const AnalyticsTab = () => (
    <div>
      <div style={{ background: '#111', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 800, letterSpacing: 1, marginBottom: 10 }}>OVERRIDE PATTERNS</div>
        {analytics ? (
          <div style={{ fontSize: 12, color: '#ccc', lineHeight: 2 }}>
            <div>Overrides this month: <b style={{ color: analytics.overridesThisMonth > 0 ? '#ff8c00' : '#6bcb77' }}>{analytics.overridesThisMonth}</b></div>
            <div>Disciplined trade win rate: <b style={{ color: '#6bcb77' }}>{analytics.disciplineWinRate ?? '—'}%</b></div>
            <div>Override trade win rate: <b style={{ color: '#ff8c00' }}>{analytics.overrideWinRate ?? '—'}%</b></div>
            <div style={{ color: '#555', fontSize: 11, marginTop: 8 }}>
              {analytics.disciplineWinRate != null && analytics.overrideWinRate != null &&
                analytics.disciplineWinRate > analytics.overrideWinRate &&
                `Following the system wins ${analytics.disciplineWinRate - analytics.overrideWinRate}% more often.`
              }
            </div>
          </div>
        ) : <div style={{ color: '#555' }}>No data yet</div>}
      </div>

      <div style={{ background: '#111', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 800, letterSpacing: 1, marginBottom: 10 }}>DISCIPLINE vs PERFORMANCE</div>
        {[
          { label: 'Score 90-100 (ELITE)',   color: '#6bcb77', trades: entries.filter(e => { const s = e.discipline?.totalScore; return s != null && s >= 90 && e.performance?.status === 'CLOSED'; }) },
          { label: 'Score 75-89 (STRONG)',   color: '#FFD700', trades: entries.filter(e => { const s = e.discipline?.totalScore; return s != null && s >= 75 && s < 90 && e.performance?.status === 'CLOSED'; }) },
          { label: 'Score 60-74 (MODERATE)', color: '#fd7e14', trades: entries.filter(e => { const s = e.discipline?.totalScore; return s != null && s >= 60 && s < 75 && e.performance?.status === 'CLOSED'; }) },
          { label: 'Score 40-59 (WEAK)',     color: '#dc3545', trades: entries.filter(e => { const s = e.discipline?.totalScore; return s != null && s >= 40 && s < 60 && e.performance?.status === 'CLOSED'; }) },
          { label: 'Score 0-39 (OVERRIDE)',  color: '#8b0000', trades: entries.filter(e => { const s = e.discipline?.totalScore; return s != null && s < 40 && e.performance?.status === 'CLOSED'; }) },
        ].map(row => {
          const winners = row.trades.filter(e => (e.performance?.realizedPnlDollar || 0) > 0);
          const winRate = row.trades.length > 0 ? Math.round(winners.length / row.trades.length * 100) : null;
          return (
            <div key={row.label} style={{ display: 'flex', gap: 20, padding: '6px 0', borderBottom: '1px solid #1a1a1a', fontSize: 12 }}>
              <span style={{ color: row.color, minWidth: 100, fontWeight: 700 }}>{row.label}</span>
              <span style={{ color: '#ccc' }}>Win Rate: <b>{winRate != null ? `${winRate}%` : '—'}</b></span>
              <span style={{ color: '#555' }}>{row.trades.length} trades</span>
            </div>
          );
        })}
      </div>

      <div style={{ background: '#111', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 800, letterSpacing: 1, marginBottom: 10 }}>RISK-ADJUSTED PERFORMANCE</div>
        {!ratios ? (
          <div style={{ color: '#555', fontSize: 12 }}>Loading…</div>
        ) : ratios.unavailable ? (
          <div style={{ color: '#555', fontSize: 12 }}>Unavailable — server endpoint not yet deployed. Merge <code style={{ color: '#888' }}>main → production</code> on Render to enable.</div>
        ) : ratios.message ? (
          <div style={{ color: '#555', fontSize: 12 }}>{ratios.message}</div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
              {[
                { label: 'SHARPE RATIO',  value: ratios.sinceInception?.sharpe,  good: 1.0, great: 2.0, unit: '', tip: 'Annualized excess return per unit of total volatility (weekly, sqrt(52)). ≥1.0 = good, ≥2.0 = great.' },
                { label: 'SORTINO RATIO', value: ratios.sinceInception?.sortino, good: 1.5, great: 3.0, unit: '', tip: 'Like Sharpe but penalises downside volatility only. ≥1.5 = good, ≥3.0 = great.' },
                { label: 'WEEKS TRACKED', value: ratios.weeksOfData, good: null, great: null, unit: ' wks', tip: 'Number of weekly return snapshots used to compute ratios.' },
              ].map(({ label, value, good, great, unit, tip }) => {
                const color = value == null || good == null ? '#888'
                  : value >= great ? '#6bcb77'
                  : value >= good  ? '#FFD700'
                  : value >= 0     ? '#fd7e14'
                  : '#dc3545';
                return (
                  <div key={label} title={tip} style={{ cursor: 'help' }}>
                    <div style={{ color: '#555', fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 2 }}>{label}</div>
                    <div style={{ color, fontSize: 22, fontWeight: 900, lineHeight: 1.1 }}>
                      {value != null ? `${value}${unit}` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
            {ratios.weeksOfData < 13 && (
              <div style={{ color: '#555', fontSize: 11, marginTop: 4 }}>
                Ratios based on {ratios.weeksOfData} week{ratios.weeksOfData !== 1 ? 's' : ''} of data — more meaningful after 13+ weeks.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Risk Advisor Exits */}
      {(() => {
        const raExitEntries = entries.filter(e =>
          e.performance?.status === 'CLOSED' &&
          e.exits?.some(x => x.reason === 'RISK_ADVISOR')
        );
        const total = raExitEntries.length;
        const avgPnl = total > 0
          ? raExitEntries.reduce((sum, e) => {
              const pnlPct = e.performance?.realizedPnlDollar != null && e.entry?.fillPrice
                ? (e.performance.realizedPnlDollar / (e.entry.fillPrice * (e.totalFilledShares || 1))) * 100
                : null;
              return sum + (pnlPct ?? 0);
            }, 0) / total
          : null;
        return (
          <div style={{ background: 'rgba(220,53,69,0.05)', border: '1px solid rgba(220,53,69,0.15)', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
            <div style={{ color: '#dc3545', fontSize: 12, fontWeight: 800, letterSpacing: 1, marginBottom: 12 }}>RISK ADVISOR EXITS</div>
            {total === 0 ? (
              <div style={{ color: '#555', fontSize: 12 }}>No Risk Advisor exits yet. When you close positions via Risk Advisor recommendation, they'll be tracked here.</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>TOTAL RA EXITS</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#e8e6e3' }}>{total}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>AVG P&L ON RA EXITS</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: avgPnl == null ? '#888' : avgPnl >= 0 ? '#28a745' : '#dc3545' }}>
                      {avgPnl == null ? '—' : `${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%`}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>DISCIPLINE SCORE</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#FFD700' }}>
                      {total > 0
                        ? (() => {
                            const avgScore = raExitEntries.reduce((sum, e) => sum + (e.discipline?.tier3?.components?.exitMethod?.score ?? 0), 0) / total;
                            return `${avgScore.toFixed(0)}/12`;
                          })()
                        : '—'}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#444', fontStyle: 'italic' }}>
                  Risk Advisor exits score 10/12 on T3-A (vs 0/12 for manual exits at a loss). Following the system is disciplined risk management.
                </div>
              </>
            )}
          </div>
        );
      })()}

      <div style={{ background: '#111', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 800, letterSpacing: 1, marginBottom: 10 }}>WASH RULES</div>
        {washRules.length === 0
          ? <div style={{ color: '#555', fontSize: 12 }}>No active wash rules.</div>
          : (() => {
              const fmtD = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '—';
              const getWashColor = (days) => days <= 3 ? '#dc3545' : days <= 7 ? '#fd7e14' : '#FFD700';
              return (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #222' }}>
                      {['TICKER', 'LOSS', 'EXIT DATE', 'EXPIRES', 'REMAINING', 'STATUS'].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: '#555', fontWeight: 700, fontSize: 10, letterSpacing: 1 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {washRules.map(r => {
                      const ws = r.washSale;
                      const days = ws.daysRemaining ?? 0;
                      const isTriggered = ws.triggered;
                      const isExpired = !isTriggered && days === 0;
                      const [statusLabel, statusColor, statusBg] = isTriggered
                        ? ['TRIGGERED', '#dc3545', 'rgba(220,53,69,0.2)']
                        : isExpired
                          ? ['CLEAR', '#6bcb77', 'rgba(107,203,119,0.15)']
                          : ['ACTIVE', '#FFD700', 'rgba(255,215,0,0.15)'];
                      return (
                        <tr key={r._id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                          <td style={{ padding: '7px 8px', color: '#FFD700', fontWeight: 800 }}>{r.ticker}</td>
                          <td style={{ padding: '7px 8px', color: '#dc3545' }}>-${Math.abs(ws.lossAmount || 0).toFixed(2)}</td>
                          <td style={{ padding: '7px 8px', color: '#888' }}>{fmtD(ws.exitDate)}</td>
                          <td style={{ padding: '7px 8px', color: '#888' }}>{fmtD(ws.expiryDate)}</td>
                          <td style={{ padding: '7px 8px', color: isTriggered ? '#555' : getWashColor(days), fontWeight: 700 }}>
                            {isTriggered ? '—' : `${days}d`}
                          </td>
                          <td style={{ padding: '7px 8px' }}>
                            <span style={{ background: statusBg, color: statusColor, padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: 10, letterSpacing: 0.5 }}>
                              {statusLabel}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              );
            })()
        }
      </div>
    </div>
  );

  const WeeklyReviewTab = () => {
    const currentWeek = getMondayOfCurrentWeek();
    const currentReview = weeklyReviews.find(r => r.weekOf === currentWeek);
    useEffect(() => {
      if (currentReview?.reflection) setWeeklyReflection(currentReview.reflection);
    }, [currentReview?.reflection]);

    const thisWeekEntries = entries.filter(e => {
      const d = new Date(e.createdAt);
      const mon = new Date(currentWeek);
      const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
      return d >= mon && d <= sun;
    });

    return (
      <div>
        <div style={{ background: '#111', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
          <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 800, letterSpacing: 1, marginBottom: 10 }}>
            WEEKLY REVIEW — Week of {currentWeek}
          </div>
          <div style={{ display: 'flex', gap: 24, marginBottom: 14, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: '#ccc' }}>Trades opened: <b style={{ color: '#fff' }}>{thisWeekEntries.filter(e => e.performance?.status === 'ACTIVE' || e.performance?.status === 'PARTIAL').length}</b></div>
            <div style={{ fontSize: 12, color: '#ccc' }}>Trades closed: <b style={{ color: '#fff' }}>{thisWeekEntries.filter(e => e.performance?.status === 'CLOSED').length}</b></div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>WEEKLY REFLECTION</div>
            <textarea
              value={weeklyReflection}
              onChange={e => setWeeklyReflection(e.target.value)}
              rows={5}
              placeholder="Write your thoughts about this week's trading..."
              style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: 6, padding: '8px 10px', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>
          <button onClick={saveWeeklyReview} disabled={savingReview}
            style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 6, padding: '6px 18px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
            {savingReview ? 'SAVING...' : 'SAVE REVIEW'}
          </button>
        </div>

        {weeklyReviews.filter(r => r.weekOf !== currentWeek).map(r => (
          <div key={r.weekOf} style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 6 }}>Week of {r.weekOf}</div>
            <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.6 }}>{r.reflection || <span style={{ color: '#333' }}>No reflection saved.</span>}</div>
          </div>
        ))}
      </div>
    );
  };

  // ── DayTradesTab ──────────────────────────────────────────────────────────
  const DayTradesTab = () => {
    const [expandedKey, setExpandedKey] = useState(null);
    const [noteEdit, setNoteEdit] = useState({}); // tradeKey → current text
    const [savingNote, setSavingNote] = useState(null);

    const totalPnl  = dayTrades.reduce((s, t) => s + (t.grossPnl || 0), 0);
    const winCount  = dayTrades.filter(t => (t.grossPnl || 0) > 0).length;
    const winRate   = dayTrades.length ? Math.round((winCount / dayTrades.length) * 100) : 0;
    const pnlColor  = totalPnl >= 0 ? '#6bcb77' : '#ff6b6b';

    function fmtTime(t) {
      if (!t) return '';
      const parts = t.trim().split(/\s+/);
      return parts[parts.length - 1] || t;
    }

    async function saveNote(tradeKey) {
      setSavingNote(tradeKey);
      try {
        await fetch(`${API_BASE}/api/journal/day-trades/${encodeURIComponent(tradeKey)}/notes`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: noteEdit[tradeKey] ?? '' }),
        });
        setDayTrades(prev => prev.map(t => t.tradeKey === tradeKey
          ? { ...t, notes: noteEdit[tradeKey] ?? '' } : t));
      } catch {}
      setSavingNote(null);
    }

    if (dayTradesLoading) return (
      <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>Loading day trades...</div>
    );

    return (
      <div>
        {/* ── Summary strip ── */}
        <div style={{ display: 'flex', gap: 24, marginBottom: 18, padding: '10px 0', borderBottom: '1px solid #1e1e1e', flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 2 }}>TOTAL TRADES</div>
            <div style={{ color: '#ccc', fontSize: 18, fontWeight: 700 }}>{dayTrades.length}</div>
          </div>
          <div>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 2 }}>WIN RATE</div>
            <div style={{ color: winRate >= 50 ? '#6bcb77' : '#ff6b6b', fontSize: 18, fontWeight: 700 }}>{winRate}%</div>
          </div>
          <div>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 2 }}>GROSS P&L</div>
            <div style={{ color: pnlColor, fontSize: 18, fontWeight: 700 }}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </div>
          </div>
          <div>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 2 }}>WINNERS</div>
            <div style={{ color: '#6bcb77', fontSize: 18, fontWeight: 700 }}>{winCount}</div>
          </div>
          <div>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 2 }}>LOSERS</div>
            <div style={{ color: '#ff6b6b', fontSize: 18, fontWeight: 700 }}>{dayTrades.length - winCount}</div>
          </div>
        </div>

        {dayTrades.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
            <div style={{ color: '#555', fontSize: 14, marginBottom: 6 }}>No day trades recorded yet.</div>
            <div style={{ color: '#444', fontSize: 12 }}>Day trades are auto-recorded from IBKR when you open and close a position on the same day without tracking it in Command.</div>
          </div>
        ) : (
          <>
            {/* ── Header row ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '90px 64px 54px 52px 80px 80px 80px 1fr', gap: 0, padding: '4px 8px', borderBottom: '1px solid #222', marginBottom: 2 }}>
              {['DATE','TICKER','DIR','SHARES','AVG BUY','AVG SELL','GROSS P&L','NOTES'].map(h => (
                <span key={h} style={{ color: '#444', fontSize: 9, fontWeight: 700, letterSpacing: 1 }}>{h}</span>
              ))}
            </div>

            {dayTrades.map(trade => {
              const isExpanded = expandedKey === trade.tradeKey;
              const pnl = trade.grossPnl || 0;
              const pnlColor = pnl > 0 ? '#6bcb77' : pnl < 0 ? '#ff6b6b' : '#888';
              const dirColor = trade.direction === 'LONG' ? '#4fc3f7' : '#ff8c00';

              return (
                <div key={trade.tradeKey} style={{ borderBottom: '1px solid #141414' }}>
                  {/* ── Main row ── */}
                  <div
                    onClick={() => setExpandedKey(isExpanded ? null : trade.tradeKey)}
                    style={{ display: 'grid', gridTemplateColumns: '90px 64px 54px 52px 80px 80px 80px 1fr', gap: 0, padding: '7px 8px', cursor: 'pointer', background: isExpanded ? 'rgba(255,255,255,0.03)' : 'transparent', alignItems: 'center' }}
                  >
                    <span style={{ color: '#666', fontSize: 11, fontFamily: 'monospace' }}>{trade.date}</span>
                    <span style={{ color: '#e0e0e0', fontSize: 12, fontWeight: 700 }}>{trade.ticker}</span>
                    <span style={{ color: dirColor, fontSize: 10, fontWeight: 700 }}>{trade.direction}</span>
                    <span style={{ color: '#ccc', fontSize: 11, textAlign: 'right', paddingRight: 12 }}>{trade.netShares}</span>
                    <span style={{ color: '#ccc', fontSize: 11, fontFamily: 'monospace', textAlign: 'right', paddingRight: 12 }}>
                      ${(trade.avgBuyPrice || 0).toFixed(2)}
                    </span>
                    <span style={{ color: '#ccc', fontSize: 11, fontFamily: 'monospace', textAlign: 'right', paddingRight: 12 }}>
                      ${(trade.avgSellPrice || 0).toFixed(2)}
                    </span>
                    <span style={{ color: pnlColor, fontSize: 12, fontWeight: 700, fontFamily: 'monospace', textAlign: 'right', paddingRight: 12 }}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                    </span>
                    <span style={{ color: '#444', fontSize: 10, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                      {trade.notes || <span style={{ color: '#2a2a2a', fontStyle: 'italic' }}>add notes…</span>}
                    </span>
                  </div>

                  {/* ── Expanded detail ── */}
                  {isExpanded && (
                    <div style={{ padding: '0 8px 12px 16px', background: 'rgba(255,255,255,0.02)' }}>
                      {/* Legs table */}
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ color: '#444', fontSize: 9, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>EXECUTIONS</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '70px 40px 52px 90px', gap: '2px 16px' }}>
                          <span style={{ color: '#333', fontSize: 9, fontWeight: 700 }}>TIME</span>
                          <span style={{ color: '#333', fontSize: 9, fontWeight: 700 }}>SIDE</span>
                          <span style={{ color: '#333', fontSize: 9, fontWeight: 700 }}>SHARES</span>
                          <span style={{ color: '#333', fontSize: 9, fontWeight: 700 }}>PRICE</span>
                          {[...(trade.legs || [])].sort((a, b) => (a.time||'').localeCompare(b.time||'')).map((leg, i) => {
                            const legColor = leg.side === 'BOT' ? '#4fc3f7' : '#ff8c00';
                            return (
                              <React.Fragment key={leg.execId || i}>
                                <span style={{ color: '#666', fontSize: 11, fontFamily: 'monospace' }}>{fmtTime(leg.time)}</span>
                                <span style={{ color: legColor, fontSize: 10, fontWeight: 700 }}>{leg.side}</span>
                                <span style={{ color: '#ccc', fontSize: 11 }}>{leg.shares}</span>
                                <span style={{ color: '#ccc', fontSize: 11, fontFamily: 'monospace' }}>${(+leg.price).toFixed(2)}</span>
                              </React.Fragment>
                            );
                          })}
                        </div>
                      </div>

                      {/* P&L breakdown */}
                      <div style={{ display: 'flex', gap: 20, marginBottom: 10, padding: '6px 10px', background: 'rgba(0,0,0,0.3)', borderRadius: 4, fontSize: 11 }}>
                        <span style={{ color: '#555' }}>Bought: <span style={{ color: '#ccc' }}>{trade.totalBought} @ ${(trade.avgBuyPrice||0).toFixed(2)}</span></span>
                        <span style={{ color: '#555' }}>Sold: <span style={{ color: '#ccc' }}>{trade.totalSold} @ ${(trade.avgSellPrice||0).toFixed(2)}</span></span>
                        <span style={{ color: '#555' }}>Net shares: <span style={{ color: '#ccc' }}>{trade.netShares}</span></span>
                        <span style={{ color: '#555' }}>Gross P&L: <span style={{ color: pnlColor, fontWeight: 700 }}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span></span>
                      </div>

                      {/* Notes */}
                      <div>
                        <div style={{ color: '#444', fontSize: 9, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>NOTES</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <textarea
                            value={noteEdit[trade.tradeKey] ?? trade.notes ?? ''}
                            onChange={e => setNoteEdit(prev => ({ ...prev, [trade.tradeKey]: e.target.value }))}
                            placeholder="Add notes about this trade…"
                            style={{
                              flex: 1, background: '#111', border: '1px solid #2a2a2a', borderRadius: 4,
                              color: '#ccc', fontSize: 11, padding: '6px 8px', resize: 'vertical', minHeight: 52,
                              fontFamily: 'inherit',
                            }}
                          />
                          <button
                            onClick={() => saveNote(trade.tradeKey)}
                            disabled={savingNote === trade.tradeKey}
                            style={{
                              background: 'transparent', border: '1px solid #444', color: '#888',
                              borderRadius: 4, padding: '5px 10px', fontSize: 10, cursor: 'pointer', fontWeight: 700,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {savingNote === trade.tradeKey ? '...' : 'SAVE'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  };

  // ── Institutional Metrics Tab (demo only) ────────────────────────────────────
  const InstitutionalTab = () => {
    const gold = '#fcf000', green = '#22c55e', red = '#ef4444', dim = '#888';

    // Hedge fund metrics — 7-year pyramid backtest net-of-costs ($100K capital, $10K full position, Jun 2019 – Apr 2026)
    // Full D1-D8 Kill scoring · 35/25/20/12/8% lots · all production gates
    // BL/SS individual = single-lot signal baseline; COMBINED = true production pyramid result
    // COVID crash stress test: Mar 2020 = +0.53% (strategy MADE money during worst crash in 90 years)
    const BL_H = { cagr: 52.1, sharpe: 2.16, sortino: 70.35, maxDrawdown: 0.35, maxDDPeriod: '2023-09 to 2023-10', calmar: 147.89, profitFactor: 8.92, bestMonth: 25.59, bestMonthLabel: '2019-07', worstMonth: -0.35, worstMonthLabel: '2023-10', positiveMonths: 74, totalMonths: 79, positiveMonthsPct: 93.7, avgMonthlyReturn: 3.68, monthlyStdDev: 5.25 };
    const SS_H = { cagr: 35.3, sharpe: 1.85, sortino: 16.54, maxDrawdown: 1.14, maxDDPeriod: '2022-10 to 2022-11', calmar: 30.99, profitFactor: 4.19, bestMonth: 14.55, bestMonthLabel: '2022-05', worstMonth: -1.14, worstMonthLabel: '2022-11', positiveMonths: 16, totalMonths: 18, positiveMonthsPct: 88.9, avgMonthlyReturn: 2.63, monthlyStdDev: 4.14 };
    const COMB = { cagr: 37.0, sharpe: 2.37, sortino: 14.16, maxDrawdown: 1.00, maxDDPeriod: '2019-09 to 2019-10', calmar: 36.92, profitFactor: 9.03, bestMonth: 11.96, bestMonthLabel: '2019-07', worstMonth: -1.00, worstMonthLabel: '2019-10', positiveMonths: 76, totalMonths: 82, positiveMonthsPct: 92.7, avgMonthlyReturn: 2.71, monthlyStdDev: 3.34 };

    // $10M demo fund metrics
    const DEMO_5Y = { startNav: '$10,000,000', endNav: '$78,293,449', totalReturn: '+682.9%', trades: '1,674', winRate: '67.4%', commissions: '$293,000', avgDiscipline: '95.4' };
    const DEMO_LF = { startNav: '$10,000,000', endNav: '$13,841,978', totalReturn: '+38.4%', trades: '292', winRate: '67.5%', commissions: '$16,676', avgDiscipline: '87' };
    const demoData = fundPeriod === 'live_fund' ? DEMO_LF : DEMO_5Y;

    const tbl = { width: '100%', borderCollapse: 'collapse', marginBottom: 16, fontSize: 12 };
    const th = { textAlign: 'left', padding: '6px 10px', color: dim, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: '1px solid #333' };
    const td = { padding: '6px 10px', color: '#ccc', borderBottom: '1px solid #1a1a1a' };
    const tdr = { ...td, textAlign: 'right' };

    return (
      <div>
        {/* ── $10M Demo Fund Summary ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ color: gold, fontSize: 13, fontWeight: 700, letterSpacing: 1, marginBottom: 12, borderBottom: '1px solid #333', paddingBottom: 6, textTransform: 'uppercase' }}>
            $10M Demo Fund — {fundPeriod === 'live_fund' ? 'PNTHR 6-16-25' : '5-Year Backtest'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {[
              { label: 'Starting NAV', value: demoData.startNav, color: '#ccc' },
              { label: 'Final NAV', value: demoData.endNav, color: gold },
              { label: 'Total Return', value: demoData.totalReturn, color: green },
              { label: 'Win Rate', value: demoData.winRate, color: green },
              { label: 'Total Trades', value: demoData.trades, color: '#ccc' },
              { label: 'Commissions', value: demoData.commissions, color: red },
              { label: 'Avg Discipline', value: demoData.avgDiscipline, color: gold },
              { label: 'Risk Model', value: '1% risk · 10% heat', color: '#ccc' },
            ].map(s => (
              <div key={s.label} style={{ background: '#1a1a1a', borderRadius: 6, padding: 12, textAlign: 'center' }}>
                <div style={{ color: s.color, fontSize: 18, fontWeight: 800, fontFamily: 'monospace' }}>{s.value}</div>
                <div style={{ color: dim, fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Annual Returns Breakdown ── */}
        {annualReturns.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ color: gold, fontSize: 13, fontWeight: 700, letterSpacing: 1, marginBottom: 12, borderBottom: '1px solid #333', paddingBottom: 6, textTransform: 'uppercase' }}>
              Annual Returns
            </div>
            <table style={tbl}>
              <thead>
                <tr>
                  <th style={th}>Year</th>
                  <th style={{ ...th, textAlign: 'right' }}>Return</th>
                  <th style={{ ...th, textAlign: 'right' }}>P&L</th>
                  <th style={{ ...th, textAlign: 'right' }}>Trades</th>
                </tr>
              </thead>
              <tbody>
                {annualReturns.map(yr => (
                  <tr key={yr.year}>
                    <td style={td}>{yr.year}{yr.partial ? ' *' : ''}</td>
                    <td style={{ ...tdr, color: yr.pct >= 0 ? green : red, fontWeight: 700 }}>{yr.pct >= 0 ? '+' : ''}{yr.pct}%</td>
                    <td style={{ ...tdr, color: yr.pnl >= 0 ? green : red }}>{yr.pnl >= 0 ? '+' : ''}${Math.round(yr.pnl).toLocaleString()}</td>
                    <td style={tdr}>{yr.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ color: '#444', fontSize: 10, fontStyle: 'italic' }}>* partial year · returns computed with compounding NAV</div>
          </div>
        )}

        {/* ── PNTHR Performance Breakdown (BL / SS / Combined) ── */}
        <div style={{ color: gold, fontSize: 13, fontWeight: 700, letterSpacing: 1, marginBottom: 12, borderBottom: '1px solid #333', paddingBottom: 6, textTransform: 'uppercase' }}>
          PNTHR Performance Breakdown
        </div>
        <div style={{ color: dim, marginBottom: 10, fontSize: 11 }}>
          $100K starting capital · $10K full position (Lots 1-5) · Annualized from monthly returns · Risk-free rate 5%
        </div>

        {/* Hero metrics grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'CAGR', value: `+${COMB.cagr}%`, color: gold },
            { label: 'Sharpe', value: COMB.sharpe, color: gold },
            { label: 'Sortino', value: COMB.sortino, color: gold },
            { label: 'Max Drawdown', value: `-${COMB.maxDrawdown}%`, color: red },
            { label: 'Calmar', value: COMB.calmar, color: gold },
            { label: 'Profit Factor', value: COMB.profitFactor, color: gold },
          ].map(s => (
            <div key={s.label} style={{ background: '#1a1a1a', borderRadius: 6, padding: 12, textAlign: 'center' }}>
              <div style={{ color: s.color, fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
              <div style={{ color: dim, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Full breakdown table */}
        <table style={tbl}>
          <thead>
            <tr>
              <th style={th}>Metric</th>
              <th style={{ ...th, textAlign: 'right' }}>BL (Longs)</th>
              <th style={{ ...th, textAlign: 'right' }}>SS (Shorts)</th>
              <th style={{ ...th, textAlign: 'right' }}>Combined</th>
            </tr>
          </thead>
          <tbody>
            {[
              { m: 'CAGR', bl: `+${BL_H.cagr}%`, ss: `+${SS_H.cagr}%`, c: `+${COMB.cagr}%`, cColor: gold, color: green },
              { m: 'Sharpe Ratio', bl: BL_H.sharpe, ss: SS_H.sharpe, c: COMB.sharpe, cColor: gold },
              { m: 'Sortino Ratio', bl: BL_H.sortino, ss: SS_H.sortino, c: COMB.sortino, cColor: gold },
              { m: 'Max Drawdown', bl: `-${BL_H.maxDrawdown}%`, ss: `-${SS_H.maxDrawdown}%`, c: `-${COMB.maxDrawdown}%`, color: red },
              { m: 'Calmar Ratio', bl: BL_H.calmar, ss: SS_H.calmar, c: COMB.calmar, cColor: gold },
              { m: 'Profit Factor', bl: BL_H.profitFactor, ss: SS_H.profitFactor, c: COMB.profitFactor, cColor: gold },
              { m: 'Win Rate', bl: '66.7%', ss: '62.2%', c: '66.3%' },
              { m: 'Avg Monthly Return', bl: `+${BL_H.avgMonthlyReturn}%`, ss: `+${SS_H.avgMonthlyReturn}%`, c: `+${COMB.avgMonthlyReturn}%`, color: green },
              { m: 'Monthly Std Dev', bl: `${BL_H.monthlyStdDev}%`, ss: `${SS_H.monthlyStdDev}%`, c: `${COMB.monthlyStdDev}%` },
              { m: 'Best Month', bl: `+${BL_H.bestMonth}%`, ss: `+${SS_H.bestMonth}%`, c: `+${COMB.bestMonth}%`, color: green },
              { m: 'Worst Month', bl: `${BL_H.worstMonth}%`, ss: `${SS_H.worstMonth}%`, c: `${COMB.worstMonth}%`, color: red },
              { m: 'Positive Months', bl: `${BL_H.positiveMonths}/${BL_H.totalMonths} (${BL_H.positiveMonthsPct}%)`, ss: `${SS_H.positiveMonths}/${SS_H.totalMonths} (${SS_H.positiveMonthsPct}%)`, c: `${COMB.positiveMonths}/${COMB.totalMonths} (${COMB.positiveMonthsPct}%)` },
              { m: 'Total Trades', bl: '1,533', ss: '143', c: '1,676', fw: true },
            ].map(r => (
              <tr key={r.m}>
                <td style={{ ...td, color: dim }}>{r.m}</td>
                <td style={{ ...tdr, color: r.color || '#ccc', fontWeight: r.fw ? 700 : 400 }}>{r.bl}</td>
                <td style={{ ...tdr, color: r.color || '#ccc', fontWeight: r.fw ? 700 : 400 }}>{r.ss}</td>
                <td style={{ ...tdr, color: r.cColor || r.color || '#ccc', fontWeight: r.cColor || r.fw ? 700 : 400 }}>{r.c}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── PNTHR vs S&P 500 ── */}
        <div style={{ color: gold, fontSize: 13, fontWeight: 700, letterSpacing: 1, marginBottom: 12, marginTop: 24, borderBottom: '1px solid #333', paddingBottom: 6, textTransform: 'uppercase' }}>
          PNTHR vs S&P 500
        </div>
        <table style={tbl}>
          <thead>
            <tr>
              <th style={th}>Metric</th>
              <th style={{ ...th, textAlign: 'right' }}>PNTHR Combined</th>
              <th style={{ ...th, textAlign: 'right' }}>S&P 500 (approx)</th>
            </tr>
          </thead>
          <tbody>
            {[
              { m: 'CAGR', p: `+${COMB.cagr}%`, s: '~10-12%', pc: gold },
              { m: 'Sharpe Ratio', p: COMB.sharpe, s: '~0.5-0.8', pc: gold },
              { m: 'Sortino Ratio', p: COMB.sortino, s: '~0.7-1.0', pc: gold },
              { m: 'Max Drawdown', p: `-${COMB.maxDrawdown}%`, s: '~-25%', pc: green, sc: red },
              { m: 'Positive Months', p: `${COMB.positiveMonthsPct}%`, s: '~60-65%', pc: gold },
              { m: 'Worst Month', p: `${COMB.worstMonth}%`, s: '~-9%', pc: green, sc: red },
            ].map(r => (
              <tr key={r.m}>
                <td style={{ ...td, color: dim }}>{r.m}</td>
                <td style={{ ...tdr, color: r.pc || '#ccc', fontWeight: 700 }}>{r.p}</td>
                <td style={{ ...tdr, color: r.sc || '#ccc' }}>{r.s}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Interpretation */}
        <div style={{ background: '#1a1a1a', borderLeft: `3px solid ${gold}`, borderRadius: 4, padding: '12px 16px', marginTop: 16 }}>
          <div style={{ color: '#fff', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Interpretation</div>
          <div style={{ color: '#aaa', fontSize: 12, lineHeight: 1.5 }}>
            Sharpe {'>'} 2.0 is exceptional — top hedge funds target 1.0-1.5. Max drawdown of -0.24% vs the S&P 500's -25% in 2022 demonstrates extreme capital protection. Pyramiding concentrates capital into winners while losers stay small (Lot 1 only). 95% positive months with a worst month of just -0.24% is institutional-grade consistency. Backtest metrics above use $100K capital with $10K full positions. The $10M Demo Fund above applies real-world constraints: 1% risk per position, 10% max portfolio heat, IBKR Pro commissions, and wash sale compliance.
          </div>
        </div>
      </div>
    );
  };

  const tabBtn = (id, label) => (
    <button onClick={() => setTab(id)}
      style={{ background: tab === id ? '#fcf000' : 'transparent', color: tab === id ? '#000' : '#666', border: `1px solid ${tab === id ? '#fcf000' : '#333'}`, borderRadius: 6, padding: '5px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}>
      {label}
    </button>
  );

  return (
    <div style={{ padding: '0 0 32px', maxWidth: 1200, color: '#fff', background: '#0a0a0a', minHeight: '100vh' }}>
      {/* ── Header — matches PNTHR Kill style ─────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '24px 24px 16px', background: '#111111', marginBottom: 20, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 22, fontWeight: 700, color: '#fcf000', margin: '0 0 4px 0' }}>
            <img src={pantherHead} alt="PNTHR" style={{ height: 36, width: 'auto' }} />
            PNTHR JOURNAL
          </h1>
          <p style={{ color: '#aaaaaa', fontSize: 13, margin: 0 }}>Trade analysis · Discipline tracking · Pattern recognition</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flex: 1, justifyContent: 'flex-end' }}>
          {/* ── Sub-tabs (left side of right group) ── */}
          {archiveTab === 'test_system' && tabBtn('trades', 'TRADES')}
          {archiveTab === 'test_system' && tabBtn('analytics', 'ANALYTICS')}
          {archiveTab === 'test_system' && tabBtn('weekly', 'WEEKLY REVIEW')}
          {archiveTab === 'test_system' && (isDemo
            ? tabBtn('institutional', 'INSTITUTIONAL METRICS')
            : tabBtn('dayTrades', 'DAY TRADES')
          )}
          {/* ── Spacer to push tabs + admin buttons far right ── */}
          <div style={{ flex: 1 }} />
          {/* ── Fund Period Toggle (demo account only) ── */}
          {isDemo && (
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #333', marginRight: 8 }}>
              <button
                onClick={() => setFundPeriod('full_backtest')}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                  background: fundPeriod === 'full_backtest' ? '#fcf000' : '#1a1a1a',
                  color: fundPeriod === 'full_backtest' ? '#111' : '#888',
                  letterSpacing: 0.3,
                }}
              >5 YEARS</button>
              <button
                onClick={() => setFundPeriod('live_fund')}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                  borderLeft: '1px solid #333',
                  background: fundPeriod === 'live_fund' ? '#fcf000' : '#1a1a1a',
                  color: fundPeriod === 'live_fund' ? '#111' : '#888',
                  letterSpacing: 0.3,
                }}
              >PNTHR 6-16-25</button>
            </div>
          )}
          {/* ── Archive Period Tabs ── */}
          {isAdmin && (
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #333', marginRight: 8, flexWrap: 'wrap' }}>
              <button onClick={() => { setArchiveTab('test_system'); setTab('trades'); }}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                  background: archiveTab === 'test_system' ? '#fcf000' : '#1a1a1a',
                  color: archiveTab === 'test_system' ? '#111' : '#888',
                  letterSpacing: 0.3,
                }}>TEST SYSTEM</button>
              {backtestYears.map(({ year, count }) => (
                <button key={year} onClick={() => { setArchiveTab(year); setTab('trades'); }}
                  style={{
                    padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                    borderLeft: '1px solid #333',
                    background: archiveTab === year ? '#fcf000' : '#1a1a1a',
                    color: archiveTab === year ? '#111' : '#888',
                    letterSpacing: 0.3,
                  }}>{year}</button>
              ))}
            </div>
          )}
          {isAdmin && entries.length > 0 && (
            <HoverTooltip lines={[
              'SYNC POSITIONS',
              'Scans your active portfolio and creates a journal entry for any position that is missing one.',
              'WHEN TO USE:',
              '• After adding new positions in Command Center',
              '• If you notice a trade is missing from the journal',
              '• After importing older positions',
              'Safe to run anytime — will not duplicate existing entries.',
            ]}>
              <button onClick={runMigration} disabled={migrating}
                style={{ background: 'transparent', border: '1px solid #444', color: '#666', borderRadius: 6, padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: migrating ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                {migrating ? '...' : '↺ sync positions'}
              </button>
            </HoverTooltip>
          )}
          {isAdmin && entries.some(e => e.performance?.status === 'CLOSED') && (
            <HoverTooltip lines={[
              'RESCORE CLOSED',
              'Recalculates the discipline score on all closed trades using the latest scoring rules.',
              'WHEN TO USE:',
              '• After IBKR auto-closes several positions at once',
              '• If discipline scores look wrong or missing',
              '• After the scoring system is updated',
              'Does not change your trade data — only recomputes scores.',
            ]}>
              <button onClick={runRescoreAll} disabled={rescoring}
                style={{ background: 'transparent', border: '1px solid rgba(212,160,23,0.4)', color: '#b8860b', borderRadius: 6, padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: rescoring ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                {rescoring ? '...' : '⚡ rescore closed'}
              </button>
            </HoverTooltip>
          )}
          {isAdmin && (
            <HoverTooltip lines={[
              'REPAIR IBKR TRADES',
              'Fixes journal entries for all IBKR auto-closed positions.',
              'WHEN TO USE:',
              '• A trade shows wrong direction or price (e.g. OLLI showing SHORT)',
              '• A trade is missing from the journal after IBKR auto-close',
              '• After adding a position directly without using the confirm flow',
              'Safe to run multiple times — already-correct entries are skipped.',
            ]}>
              <button onClick={runIbkrRepair} disabled={ibkrRepairing}
                style={{ background: 'transparent', border: '1px solid rgba(220,53,69,0.4)', color: '#9b2335', borderRadius: 6, padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: ibkrRepairing ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                {ibkrRepairing ? '...' : '🔧 repair IBKR'}
              </button>
            </HoverTooltip>
          )}
        </div>
      </div>

      {/* ── Growth Chart Buttons (below year tabs) ── */}
      {isAdmin && backtestYears.length > 0 && (
        <div style={{ padding: '0 24px 8px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#555', fontSize: 10, fontWeight: 700, letterSpacing: 0.5, marginRight: 4 }}>GROWTH CHARTS</span>
          {backtestYears.map(({ year }) => (
            <button key={year}
              onClick={() => setGrowthChartYear(growthChartYear === year ? null : year)}
              style={{
                padding: '4px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                border: growthChartYear === year ? '1px solid #fcf000' : '1px solid #333',
                borderRadius: 4,
                background: growthChartYear === year ? '#fcf000' : '#111',
                color: growthChartYear === year ? '#111' : '#666',
                letterSpacing: 0.3,
              }}>{year}</button>
          ))}
          <button
            onClick={() => setGrowthChartYear(growthChartYear === 'all' ? null : 'all')}
            style={{
              padding: '4px 14px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
              border: growthChartYear === 'all' ? '1px solid #fcf000' : '1px solid #555',
              borderRadius: 4,
              background: growthChartYear === 'all' ? '#fcf000' : '#111',
              color: growthChartYear === 'all' ? '#111' : '#fcf000',
              letterSpacing: 0.5,
            }}>CUMULATIVE 2019–2026</button>
          <button
            onClick={() => { setShowCalculator(true); if (!monthlyReturns) setGrowthChartYear(prev => prev || 'all'); }}
            style={{
              padding: '4px 14px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
              border: '1px solid #4ecdc4', borderRadius: 4, marginLeft: 8,
              background: '#111', color: '#4ecdc4', letterSpacing: 0.5,
            }}>RETURN CALCULATOR</button>
          <a
            href="/PNTHR_PPM_v4.pdf"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: '4px 14px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
              border: '1px solid #555', borderRadius: 4, marginLeft: 4,
              background: '#111', color: '#888', letterSpacing: 0.5, textDecoration: 'none',
              display: 'inline-block',
            }}>PPM v4 ↓</a>
        </div>
      )}

      {/* ── Growth Chart ── */}
      {growthChartYear && monthlyReturns && (
        <div style={{ padding: '0 24px 16px' }}>
          <GrowthChart
            monthlyReturns={monthlyReturns}
            hurdleRates={hurdleRates}
            yearFilter={growthChartYear}
            showDataBoxes
          />
        </div>
      )}

      <div style={{ padding: '0 24px' }}>
      {/* Rescore result toast */}
      {rescoreResult && (
        <div style={{ background: rescoreResult.error ? 'rgba(220,53,69,0.15)' : 'rgba(212,160,23,0.12)', border: `1px solid ${rescoreResult.error ? '#dc3545' : '#D4A017'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 10, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: rescoreResult.error ? '#ff6b6b' : '#FFD700' }}>
            {rescoreResult.error
              ? `Rescore error: ${rescoreResult.error}`
              : `⚡ Rescored ${rescoreResult.count} trade${rescoreResult.count !== 1 ? 's' : ''}: ${rescoreResult.results?.map(r => `${r.ticker} ${r.newScore}${r.fixes?.length ? ` (+${r.fixes.join(',')})` : ''}`).join(', ')}`
            }
          </span>
          <button onClick={() => setRescoreResult(null)} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
      )}

      {/* IBKR repair result toast */}
      {ibkrRepairResult && (
        <div style={{ background: ibkrRepairResult.error ? 'rgba(220,53,69,0.15)' : 'rgba(40,167,69,0.15)', border: `1px solid ${ibkrRepairResult.error ? '#dc3545' : '#28a745'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 10, fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <span style={{ color: ibkrRepairResult.error ? '#ff6b6b' : '#6bcb77', fontWeight: 700 }}>
              {ibkrRepairResult.error
                ? `🔧 Repair error: ${ibkrRepairResult.error}`
                : `🔧 Repaired ${ibkrRepairResult.repaired} of ${ibkrRepairResult.total} IBKR trades`}
            </span>
            <button onClick={() => setIbkrRepairResult(null)} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14, marginLeft: 12 }}>✕</button>
          </div>
          {ibkrRepairResult.log?.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {ibkrRepairResult.log.map((line, i) => (
                <span key={i} style={{ color: line.startsWith('✅') ? '#6bcb77' : line.startsWith('❌') ? '#ff6b6b' : '#777', fontSize: 11, fontFamily: 'monospace' }}>{line}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Migration result toast */}
      {migrateResult && (
        <div style={{ background: migrateResult.error ? 'rgba(220,53,69,0.15)' : 'rgba(40,167,69,0.15)', border: `1px solid ${migrateResult.error ? '#dc3545' : '#28a745'}`, borderRadius: 6, padding: '8px 14px', marginBottom: 10, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: migrateResult.error ? '#ff6b6b' : '#6bcb77' }}>
            {migrateResult.error
              ? `Error: ${migrateResult.error}`
              : `✓ Done — ${migrateResult.created} new, ${migrateResult.updated || 0} refreshed from Command, ${migrateResult.claimed || 0} claimed (${migrateResult.total} total)`}
          </span>
          <button onClick={() => setMigrateResult(null)} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
      )}

      {loading ? (
        <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>Loading journal...</div>
      ) : (
        <>
          {(archiveTab === 'test_system') && <DisciplineStrip />}

          {tab === 'trades' && (
            <TradeDetailBoundary>
              {/* ── Archive: Yearly Backtest Tab ── */}
              {archiveTab !== 'test_system' ? (
                <div>
                  <div style={{ color: '#fcf000', fontSize: 13, fontWeight: 800, letterSpacing: 1, marginBottom: 16, borderBottom: '1px solid #333', paddingBottom: 8 }}>
                    {archiveTab} BACKTEST TRADES
                  </div>
                  {backtestLoading ? (
                    <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>Loading {archiveTab} trades...</div>
                  ) : (
                    <>
                      {/* Summary bar */}
                      {backtestSummary && (
                        <div style={{ display: 'flex', gap: 24, marginBottom: 18, padding: '12px 16px', background: '#111', borderRadius: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          <div>
                            <div style={{ color: '#555', fontSize: 9, letterSpacing: 1, fontWeight: 700, marginBottom: 2 }}>TOTAL TRADES</div>
                            <div style={{ color: '#ccc', fontSize: 18, fontWeight: 700 }}>{backtestSummary.totalTrades ?? backtestTrades.length}</div>
                          </div>
                          <div>
                            <div style={{ color: '#555', fontSize: 9, letterSpacing: 1, fontWeight: 700, marginBottom: 2 }}>WIN RATE</div>
                            <div style={{ color: (backtestSummary.winRate ?? 0) >= 50 ? '#6bcb77' : '#ff6b6b', fontSize: 18, fontWeight: 700 }}>
                              {backtestSummary.winRate != null ? `${backtestSummary.winRate}%` : '—'}
                            </div>
                          </div>
                          <div>
                            <div style={{ color: '#555', fontSize: 9, letterSpacing: 1, fontWeight: 700, marginBottom: 2 }}>TOTAL P&L</div>
                            <div style={{ color: (backtestSummary.totalPnl ?? 0) >= 0 ? '#6bcb77' : '#ff6b6b', fontSize: 18, fontWeight: 700 }}>
                              {backtestSummary.totalPnl != null ? `${backtestSummary.totalPnl >= 0 ? '+' : ''}$${Math.abs(backtestSummary.totalPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </div>
                          </div>
                          <div>
                            <div style={{ color: '#555', fontSize: 9, letterSpacing: 1, fontWeight: 700, marginBottom: 2 }}>AVG P&L</div>
                            <div style={{ color: (backtestSummary.avgPnl ?? 0) >= 0 ? '#6bcb77' : '#ff6b6b', fontSize: 18, fontWeight: 700 }}>
                              {backtestSummary.avgPnl != null ? `${backtestSummary.avgPnl >= 0 ? '+' : ''}$${Math.abs(backtestSummary.avgPnl).toFixed(2)}` : '—'}
                            </div>
                          </div>
                          <div style={{ position: 'relative', marginLeft: 'auto' }}>
                            <button onClick={() => setShowBacktestMetrics(!showBacktestMetrics)}
                              style={{ background: showBacktestMetrics ? '#fcf000' : '#1a1a1a', color: showBacktestMetrics ? '#111' : '#fcf000', border: '1px solid #fcf000', borderRadius: 6, padding: '8px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>
                              BACKTEST METRICS
                            </button>
                            {showBacktestMetrics && (
                              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 8, background: '#111', border: '1px solid #333', borderRadius: 8, padding: '16px 20px', width: 340, zIndex: 100, boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
                                <div style={{ color: '#fcf000', fontSize: 13, fontWeight: 800, letterSpacing: 1, marginBottom: 12, borderBottom: '1px solid #333', paddingBottom: 8 }}>PNTHR PYRAMID SYSTEM</div>
                                <div style={{ color: '#888', fontSize: 11, lineHeight: 1.8 }}>
                                  <div style={{ color: '#ccc', fontWeight: 700, marginBottom: 4 }}>Starting Capital: $100,000</div>
                                  <div><span style={{ color: '#ccc' }}>Max risk per trade:</span> 1% of NAV (0.5% ETFs)</div>
                                  <div><span style={{ color: '#ccc' }}>Max portfolio heat:</span> 10% at any time</div>
                                  <div style={{ color: '#fcf000', fontWeight: 700, marginTop: 10, marginBottom: 4 }}>LOT ALLOCATION</div>
                                  <div>Lot 1 (The Scent): 35%</div>
                                  <div>Lot 2 (The Stalk): 25%</div>
                                  <div>Lot 3 (The Strike): 20%</div>
                                  <div>Lot 4 (The Jugular): 12%</div>
                                  <div>Lot 5 (The Kill): 8%</div>
                                  <div style={{ color: '#fcf000', fontWeight: 700, marginTop: 10, marginBottom: 4 }}>LOT TRIGGERS</div>
                                  <div>Lot 1: Entry (0%)</div>
                                  <div>Lot 2: +3% from anchor</div>
                                  <div>Lot 3: +6% from anchor</div>
                                  <div>Lot 4: +10% from anchor</div>
                                  <div>Lot 5: +14% from anchor</div>
                                  <div style={{ color: '#fcf000', fontWeight: 700, marginTop: 10, marginBottom: 4 }}>FRICTION COSTS (NET P&L)</div>
                                  <div>Commissions: IBKR Pro $0.005/shr ($1 min)</div>
                                  <div>Slippage: 5 bps per leg (10 bps round-trip)</div>
                                  <div>Short borrow: 1.0–2.0% annualized by sector</div>
                                  <div style={{ color: '#fcf000', fontWeight: 700, marginTop: 10, marginBottom: 4 }}>RULES</div>
                                  <div>5-day time gate on Lot 2</div>
                                  <div>Stop ratchets on each lot fill</div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {backtestTrades.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 48 }}>
                          <div style={{ color: '#555', fontSize: 14, marginBottom: 6 }}>No backtest trades for {archiveTab}.</div>
                          <div style={{ color: '#444', fontSize: 12 }}>Backtest data will appear here once the yearly archive endpoints are populated.</div>
                        </div>
                      ) : (
                        <div style={{ background: '#111', borderRadius: 10, overflow: 'hidden' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                {['DATE', 'TICKER', 'DIR', 'ENTRY $', 'EXIT $', 'P&L', 'NET P&L', 'DAYS', 'EXIT REASON', 'KILL SCORE', 'LOTS'].map(h => (
                                  <th key={h} style={{ color: '#666', fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #222', whiteSpace: 'nowrap' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {backtestTrades.map((t, i) => {
                                const pnl = t.dollarPnl ?? t.pnl ?? t.pnlDollar ?? 0;
                                const netPnl = t.netDollarPnl ?? t.netPnl ?? t.netPnlDollar ?? pnl;
                                const dir = t.direction || t.signal || '—';
                                return (
                                  <tr key={t._id || t.tradeId || i} style={{ borderBottom: '1px solid #1a1a1a' }}
                                    onMouseEnter={e => e.currentTarget.style.background = '#151515'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <td style={tdStyle}>{t.entryDate || t.date || '—'}</td>
                                    <td style={{ ...tdStyle, color: '#fcf000', fontWeight: 800 }}>{t.ticker}</td>
                                    <td style={tdStyle}>
                                      <span style={{ background: dir === 'LONG' || dir === 'BL' ? 'rgba(40,167,69,0.2)' : 'rgba(220,53,69,0.2)', color: dir === 'LONG' || dir === 'BL' ? '#6bcb77' : '#ff6b6b', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
                                        {dir === 'BL' ? 'LONG' : dir === 'SS' ? 'SHORT' : dir}
                                      </span>
                                    </td>
                                    <td style={tdStyle}>{t.entryPrice != null ? `$${Number(t.entryPrice).toFixed(2)}` : '—'}</td>
                                    <td style={tdStyle}>{t.exitPrice != null ? `$${Number(t.exitPrice).toFixed(2)}` : '—'}</td>
                                    <td style={{ ...tdStyle, color: pnl >= 0 ? '#6bcb77' : '#ff6b6b', fontWeight: 700 }}>
                                      {pnl >= 0 ? '+' : ''}{`$${Math.abs(pnl).toFixed(2)}`}
                                    </td>
                                    <td style={{ ...tdStyle, color: netPnl >= 0 ? '#6bcb77' : '#ff6b6b', fontWeight: 700 }}>
                                      {netPnl >= 0 ? '+' : ''}{`$${Math.abs(netPnl).toFixed(2)}`}
                                    </td>
                                    <td style={tdStyle}>{t.tradingDays ?? t.days ?? t.holdingDays ?? '—'}</td>
                                    <td style={tdStyle}>
                                      <span style={{ color: t.exitReason === 'SIGNAL' ? '#6bcb77' : t.exitReason === 'FEAST' ? '#fcf000' : t.exitReason === 'STOP_HIT' ? '#ff8c00' : '#888', fontWeight: 700, fontSize: 10 }}>
                                        {t.exitReason || '—'}
                                      </span>
                                    </td>
                                    <td style={tdStyle}>
                                      {t.killScore != null ? <span style={{ color: '#fcf000', fontWeight: 700 }}>{t.killScore}</span> : <span style={{ color: '#555' }}>—</span>}
                                    </td>
                                    <td style={tdStyle}>{typeof t.maxLots === 'number' ? t.maxLots : Array.isArray(t.lots) ? t.lots.length : t.lotCount ?? '—'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}

                  {/* ── 2026 System Trades (below backtest divider) ── */}
                  {archiveTab === new Date().getFullYear().toString() && (
                    <>
                      <div style={{ borderTop: '2px solid #fcf000', margin: '24px 0 16px', position: 'relative' }}>
                        <span style={{ position: 'absolute', top: -10, left: 16, background: '#0a0a0a', padding: '0 10px', color: '#fcf000', fontSize: 11, fontWeight: 800, letterSpacing: 1 }}>
                          LIVE SYSTEM TRADES
                        </span>
                      </div>
                      {systemTradesLoading ? (
                        <div style={{ color: '#555', textAlign: 'center', padding: 24 }}>Loading system trades...</div>
                      ) : systemTrades.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 32 }}>
                          <div style={{ color: '#555', fontSize: 13 }}>No system trades yet.</div>
                          <div style={{ color: '#444', fontSize: 11, marginTop: 4 }}>Trades confirmed from PNTHR Orders will appear here.</div>
                        </div>
                      ) : (
                        <div style={{ background: '#111', borderRadius: 10, overflow: 'hidden' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                {['DATE', 'TICKER', 'DIR', 'ENTRY $', 'EXIT $', 'P&L', 'DISC.', 'KILL', 'STATUS'].map(h => (
                                  <th key={h} style={{ color: '#666', fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #222', whiteSpace: 'nowrap' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {systemTrades.map((t, i) => {
                                const pnl = t.performance?.realizedPnlDollar;
                                const disc = t.discipline?.totalScore;
                                return (
                                  <tr key={t._id || i} style={{ borderBottom: '1px solid #1a1a1a' }}
                                    onMouseEnter={e => e.currentTarget.style.background = '#151515'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <td style={tdStyle}>{t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }) : '—'}</td>
                                    <td style={{ ...tdStyle, color: '#fcf000', fontWeight: 800 }}>{t.ticker}</td>
                                    <td style={tdStyle}>
                                      <span style={{ background: t.direction === 'LONG' ? 'rgba(40,167,69,0.2)' : 'rgba(220,53,69,0.2)', color: t.direction === 'LONG' ? '#6bcb77' : '#ff6b6b', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
                                        {t.direction || '—'}
                                      </span>
                                    </td>
                                    <td style={tdStyle}>{t.entry?.fillPrice != null ? `$${t.entry.fillPrice.toFixed(2)}` : '—'}</td>
                                    <td style={tdStyle}>{t.performance?.avgExitPrice != null ? `$${t.performance.avgExitPrice.toFixed(2)}` : '—'}</td>
                                    <td style={{ ...tdStyle, color: pnl == null ? '#555' : pnl >= 0 ? '#6bcb77' : '#ff6b6b', fontWeight: 700 }}>
                                      {pnl != null ? `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)}` : '—'}
                                    </td>
                                    <td style={tdStyle}>
                                      {disc != null ? <span style={{ color: disc >= 75 ? '#6bcb77' : disc >= 55 ? '#fcf000' : '#ff6b6b', fontWeight: 800 }}>{disc}</span> : <span style={{ color: '#555' }}>—</span>}
                                    </td>
                                    <td style={tdStyle}>
                                      {t.entry?.killRank ? <span style={{ color: '#fcf000', fontWeight: 700 }}>#{t.entry.killRank}</span> : <span style={{ color: '#555' }}>—</span>}
                                    </td>
                                    <td style={tdStyle}>
                                      <span style={{ background: t.performance?.status === 'ACTIVE' ? 'rgba(40,167,69,0.2)' : t.performance?.status === 'CLOSED' ? 'rgba(108,117,125,0.2)' : 'rgba(255,193,7,0.2)', color: t.performance?.status === 'ACTIVE' ? '#6bcb77' : t.performance?.status === 'CLOSED' ? '#888' : '#ffc107', fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 700 }}>
                                        {t.performance?.status || 'ACTIVE'}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </div>

              /* ── Test System: Full Journal Layout ── */
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                    {['ALL', 'ACTIVE', 'PARTIAL', 'CLOSED', 'OVERRIDES'].map(f => (
                      <button key={f} onClick={() => setFilterStatus(f)}
                        style={{ background: filterStatus === f ? '#333' : 'transparent', color: filterStatus === f ? '#fcf000' : '#555', border: `1px solid ${filterStatus === f ? '#555' : '#222'}`, borderRadius: 4, padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}>
                        {f}
                      </button>
                    ))}
                    <span style={{ color: '#333', fontSize: 11, alignSelf: 'center', marginLeft: 8 }}>{sorted.length} trade{sorted.length !== 1 ? 's' : ''}</span>
                  </div>

                  {sorted.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <div style={{ color: '#555', fontSize: 14, marginBottom: 16 }}>
                        No journal entries yet. Journal entries are auto-created when you confirm a position in Command.
                      </div>
                      {isAdmin && (
                        <div>
                          <div style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>Have existing positions? Import them now:</div>
                          <button onClick={runMigration} disabled={migrating}
                            style={{ background: '#fcf000', color: '#000', border: 'none', borderRadius: 6, padding: '7px 20px', fontSize: 12, fontWeight: 800, cursor: migrating ? 'not-allowed' : 'pointer', letterSpacing: 1 }}>
                            {migrating ? 'IMPORTING...' : 'IMPORT EXISTING POSITIONS'}
                          </button>
                          {migrateResult && (
                            <div style={{ marginTop: 8, fontSize: 12, color: migrateResult.error ? '#ff6b6b' : '#6bcb77' }}>
                              {migrateResult.error ? `Error: ${migrateResult.error}` : `Done — ${migrateResult.created} new, ${migrateResult.updated || 0} refreshed from Command`}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : filterStatus === 'CLOSED' ? (
                    <ClosedTradeCards focusPositionId={focusPositionId} focusTicker={focusTicker} />
                  ) : (
                    <div style={{ background: '#111', borderRadius: 10, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            {[['createdAt', 'DATE'], ['ticker', 'TICKER'], ['direction', 'DIR'], ['entry.fillPrice', 'ENTRY $'], ['performance.avgExitPrice', 'EXIT $'], ['performance.realizedPnlDollar', 'P&L'], ['discipline.totalScore', 'DISC.'], ['entry.killRank', 'KILL'], ['washRule', 'WASH'], ['tags', 'TAGS']].map(([f, l]) => (
                              <th key={f} style={thStyle(f)} onClick={() => handleSort(f)}>
                                {l} {sortField === f ? (sortDir === -1 ? '▼' : '▲') : ''}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map(entry => {
                            const isExpanded = expandedId === entry._id;
                            const pnl = entry.performance?.realizedPnlDollar;
                            const disc = entry.discipline?.totalScore;
                            const wash = entry.washSale?.isLoss ? entry.washSale : entry.washRule;
                            const washExpiry = wash?.isLoss && wash?.expiryDate ? new Date(wash.expiryDate) : null;
                            const washDays = washExpiry ? Math.max(0, Math.ceil((washExpiry - new Date()) / 86400000)) : null;
                            const washTriggered = wash?.triggered;
                            const washExpired = washExpiry && washExpiry <= new Date() && !washTriggered;
                            return (
                              <React.Fragment key={entry._id}>
                                <tr
                                  onClick={() => setExpandedId(isExpanded ? null : entry._id)}
                                  style={{ cursor: 'pointer', background: isExpanded ? '#0d0d0d' : 'transparent' }}
                                  onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = '#151515'; }}
                                  onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <td style={tdStyle}>{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }) : '—'}</td>
                                  <td style={{ ...tdStyle, color: '#fcf000', fontWeight: 800 }}>{entry.ticker}</td>
                                  <td style={tdStyle}>
                                    <span style={{ background: entry.direction === 'LONG' ? 'rgba(40,167,69,0.2)' : 'rgba(220,53,69,0.2)', color: entry.direction === 'LONG' ? '#6bcb77' : '#ff6b6b', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
                                      {entry.direction}
                                    </span>
                                  </td>
                                  <td style={tdStyle}>{entry.entry?.fillPrice != null ? `$${entry.entry.fillPrice.toFixed(2)}` : '—'}</td>
                                  <td style={tdStyle}>{entry.performance?.avgExitPrice != null ? `$${entry.performance.avgExitPrice.toFixed(2)}` : entry.performance?.status === 'ACTIVE' ? <span style={{ color: '#555' }}>—</span> : <span style={{ color: '#555' }}>partial</span>}</td>
                                  <td style={{ ...tdStyle, color: pnl == null ? '#555' : pnl >= 0 ? '#6bcb77' : '#ff6b6b', fontWeight: 700 }}>
                                    {pnl != null ? `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)}` : '—'}
                                  </td>
                                  <td style={tdStyle}>
                                    {disc != null
                                      ? <span style={{ color: DISC_COLORS(disc), fontWeight: 800 }}>{disc}{(entry.discipline?.overrideCount || 0) > 0 ? ' ⚠' : ''}</span>
                                      : <span style={{ color: '#555' }}>—</span>}
                                  </td>
                                  <td style={tdStyle}>
                                    {entry.entry?.killRank
                                      ? <span style={{ color: '#fcf000', fontWeight: 700 }}>#{entry.entry.killRank}{entry.entry.isKillTop10 ? ' *' : ''}</span>
                                      : <span style={{ color: '#555' }}>—</span>}
                                  </td>
                                  <td style={tdStyle}>
                                    {washTriggered
                                      ? <span title={wash.triggeredDate ? `Triggered ${new Date(wash.triggeredDate).toLocaleDateString()}` : 'Wash sale triggered'}
                                          style={{ background: 'rgba(220,53,69,0.2)', color: '#dc3545', padding: '2px 8px', borderRadius: 4, fontWeight: 600, fontSize: '0.75rem' }}>WASH</span>
                                      : washDays != null && washDays > 0
                                        ? <span title={washExpiry ? `Expires ${washExpiry.toLocaleDateString('en-US',{month:'2-digit',day:'2-digit',year:'numeric'})}` : ''}
                                            style={{ color: '#fcf000', fontWeight: 600, fontSize: '0.85rem' }}>{washDays}d</span>
                                        : washExpired
                                          ? <span title={washExpiry ? `Expired ${washExpiry.toLocaleDateString()}` : ''} style={{ color: '#28a745', fontSize: '0.85rem' }}>✓</span>
                                          : <span style={{ color: '#333' }}>—</span>}
                                  </td>
                                  <td style={tdStyle}>
                                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                      {(entry.tags || []).slice(0, 2).map(t => (
                                        <span key={t} style={{ background: '#1a1a1a', color: '#666', fontSize: 9, padding: '1px 5px', borderRadius: 3 }}>{t}</span>
                                      ))}
                                      {(entry.tags || []).length > 2 && <span style={{ color: '#444', fontSize: 9 }}>+{entry.tags.length - 2}</span>}
                                    </div>
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr>
                                    <td colSpan={10} style={{ padding: '0 8px 8px', background: '#0d0d0d' }}>
                                      <TradeDetailBoundary>
                                        <TradeDetail entry={entry} noteInputs={noteInputs} setNoteInputs={setNoteInputs} addNote={addNote} deleteNote={deleteNote} addTag={addTag} removeTag={removeTag} />
                                      </TradeDetailBoundary>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </TradeDetailBoundary>
          )}

          {tab === 'analytics' && <AnalyticsTab />}
          {tab === 'weekly' && <WeeklyReviewTab />}
          {tab === 'dayTrades' && <DayTradesTab />}
          {tab === 'institutional' && <InstitutionalTab />}
        </>
      )}
      </div>

      {/* ── Investor Return Calculator Modal ── */}
      {showCalculator && monthlyReturns && (
        <InvestorCalculator
          monthlyReturns={monthlyReturns}
          hurdleRates={hurdleRates}
          onClose={() => setShowCalculator(false)}
        />
      )}
    </div>
  );
}
