// client/src/components/PyramidPlanModal.jsx
// ── Pyramid plan editor for single-shot positions ──────────────────────────
//
// Replaces the window.prompt + window.confirm two-step flow with a real modal
// that lets the trader:
//   • See L1 (already filled in TWS) with shares + actual fill price + date
//   • Edit per-lot share counts for L2-L5 (each lot independent)
//   • See LIVE risk math at every change: per-lot $ risk at the trigger vs
//     ORIGINAL stop, cumulative shares, cumulative cost basis, cumulative
//     dollar risk, and cumulative risk as % of NAV
//   • Apply (writes the plan + clears autoOpenedByIBKR so the lot-trigger
//     cron stages L2-L5 in TWS within ~60s)
//   • Dismiss (mark this position pyramidDismissed=true so the PYRAMID
//     button disappears from this row going forward — for positions where
//     the trader has intentionally maxed out at single-shot size)
//   • Cancel (close without changes)
//
// Math: anchor = actual L1 fill price. Trigger prices are anchor × (1 + offset)
// for LONG, anchor × (1 - offset) for SHORT, where offsets are 3/6/10/14% for
// L2/L3/L4/L5. Mirrors lotMath.js exactly so what the trader sees here matches
// what the lot-trigger cron will stage in TWS.

import { useState, useMemo, useEffect } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const LOT_OFFSETS = [0, 0.03, 0.06, 0.10, 0.14];
const LOT_NAMES   = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];

function fmtUsd(n)  { return n == null || !Number.isFinite(+n) ? '—' : `$${Math.abs(+n).toFixed(2)}`; }
function fmtUsd0(n) { return n == null || !Number.isFinite(+n) ? '—' : `$${Math.round(+n).toLocaleString()}`; }
function fmtPct(n)  { return n == null || !Number.isFinite(+n) ? '—' : `${(+n).toFixed(2)}%`; }

export default function PyramidPlanModal({ ticker, positionId, onClose, onApplied }) {
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [meta,       setMeta]       = useState(null);  // { nav, originalStop, direction, currentL1, anchor }
  const [shares,     setShares]     = useState({ 2: 0, 3: 0, 4: 0, 5: 0 });

  // Initial preview load. Hits the dry-run endpoint with no overrides to
  // pull NAV, original stop, direction, anchor, and the canonical per-lot
  // recommendations (which may all be zero, which is the whole point of
  // letting the trader override here).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/positions/${positionId}/convert-to-pyramid?dryRun=1`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          if (!cancelled) setError(e.error || `HTTP ${r.status}`);
          if (!cancelled) setLoading(false);
          return;
        }
        const data = await r.json();
        if (cancelled) return;

        const direction = (data.direction || 'LONG').toUpperCase();
        const anchor    = data.anchor || data.currentL1?.price || 0;
        const nav       = data.nav || 0;
        const origStop  = data.originalStop || 0;
        setMeta({
          nav,
          originalStop: origStop,
          direction,
          anchor,
          currentL1:    data.currentL1 || {},
        });

        // ── 1% NAV risk-budget recommendation ─────────────────────────────────
        // Pre-fix the modal pre-filled with canonical share-weighted math
        // (35/25/20/12/8 of total shares from `floor(vitality / L1_rps)`).
        // That sizes L1 to 1% NAV but L2-L5 ADD risk on top because their
        // trigger prices are higher (greater rps). Cumulative risk routinely
        // exceeded 1% — OVV came in at 1.21%, MUR at 1.36%.
        //
        // The PNTHR fund rule is 1% TOTAL NAV across the full pyramid, not
        // 1% on L1 alone. So the real recommendation is:
        //   • Total risk budget = 1% × NAV
        //   • Subtract L1 actual risk (already filled, fixed)
        //   • Distribute remaining budget across L2-L5 by 30/25/20/10 weights
        //     (canonical L1-aware redistribution shape, sum 85)
        //   • shares = budgetForLot / lotRiskPerShare
        const isLong   = direction !== 'SHORT';
        const l1Shares = +data.currentL1?.shares || 0;
        const l1Risk   = origStop > 0 && anchor > 0
          ? (isLong ? Math.max(0, anchor - origStop) : Math.max(0, origStop - anchor)) * l1Shares
          : 0;
        const budgetTotal     = nav * 0.01;
        const budgetRemaining = Math.max(0, budgetTotal - l1Risk);

        const weights = { 2: 30, 3: 25, 4: 20, 5: 10 };
        const sumW    = 30 + 25 + 20 + 10;
        const rec     = { 2: 0, 3: 0, 4: 0, 5: 0 };
        for (const lot of [2, 3, 4, 5]) {
          const i = lot - 1;
          const trigger = +(anchor * (isLong ? (1 + LOT_OFFSETS[i]) : (1 - LOT_OFFSETS[i]))).toFixed(2);
          const rps     = isLong
            ? Math.max(0, trigger - origStop)
            : Math.max(0, origStop - trigger);
          const lotBudget = budgetRemaining * weights[lot] / sumW;
          rec[lot] = rps > 0 ? Math.floor(lotBudget / rps) : 0;
        }
        setShares(rec);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Network error');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [positionId]);

  // ── Live math (recomputes on every share-input keystroke) ─────────────────
  const computed = useMemo(() => {
    if (!meta) return null;
    const isLong   = meta.direction !== 'SHORT';
    const anchor   = +meta.anchor || 0;
    const origStop = +meta.originalStop || 0;
    const nav      = +meta.nav || 0;
    const l1Shares = +meta.currentL1?.shares || 0;
    const l1Price  = +meta.currentL1?.price || anchor;

    const rows = [];
    let cumShares = 0;
    let cumCost   = 0;
    let cumRisk   = 0;
    for (let i = 0; i < 5; i++) {
      const lot      = i + 1;
      const sh       = i === 0 ? l1Shares : (+shares[lot] || 0);
      const px       = i === 0
        ? l1Price
        : +(anchor * (isLong ? (1 + LOT_OFFSETS[i]) : (1 - LOT_OFFSETS[i]))).toFixed(2);
      const riskPS   = origStop > 0
        ? (isLong ? Math.max(0, px - origStop) : Math.max(0, origStop - px))
        : 0;
      const lotRisk  = riskPS * sh;
      cumShares += sh;
      cumCost   += px * sh;
      cumRisk   += lotRisk;
      rows.push({
        lot, name: LOT_NAMES[i], shares: sh, triggerPrice: px,
        riskPerShare: riskPS, lotRisk,
        cumShares, cumCost, cumRisk,
        cumRiskPctNav: nav > 0 ? cumRisk / nav * 100 : 0,
      });
    }
    return { rows, totals: rows[rows.length - 1] };
  }, [meta, shares]);

  const apply = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/positions/${positionId}/convert-to-pyramid`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ lotShares: shares }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(e.error || `HTTP ${r.status}`);
        setSubmitting(false);
        return;
      }
      onApplied?.();
      onClose?.();
    } catch (e) {
      setError(e.message || 'Network error');
      setSubmitting(false);
    }
  };

  const dismiss = async () => {
    if (submitting) return;
    if (!window.confirm(
      `Dismiss the pyramid prompt for ${ticker}?\n\n` +
      `The PYRAMID button will stop appearing on this row. The position stays single-shot at its current size. Re-enable later by editing the position's pyramidDismissed flag in Command Center.`
    )) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/positions/${positionId}/convert-to-pyramid`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismiss: true }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(e.error || `HTTP ${r.status}`);
        setSubmitting(false);
        return;
      }
      onApplied?.();
      onClose?.();
    } catch (e) {
      setError(e.message || 'Network error');
      setSubmitting(false);
    }
  };

  const totalShares = computed?.totals?.cumShares || 0;
  const totalRisk   = computed?.totals?.cumRisk   || 0;
  const totalRiskPct = computed?.totals?.cumRiskPctNav || 0;
  const overOnePct  = totalRiskPct > 1.0;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0a0a0a',
          border: '1px solid rgba(252,240,0,0.4)',
          borderRadius: 8,
          maxWidth: 720,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          fontFamily: "'Inter', 'Segoe UI', sans-serif",
          color: '#e6e6e6',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid rgba(252,240,0,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#FCF000', letterSpacing: '0.04em' }}>
              ▲ PYRAMID PLAN — {ticker}
            </div>
            <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
              L2-L5 pre-filled to target <span style={{ color: '#FCF000', fontWeight: 700 }}>1% NAV total risk</span> if all lots fill. L1 is your actual TWS fill (not editable). Edit any lot to override.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
              color: '#aaa', borderRadius: 4, padding: '4px 10px',
              fontSize: 11, cursor: 'pointer',
            }}
          >✕ CLOSE</button>
        </div>

        {/* Body */}
        <div style={{ padding: 18 }}>
          {loading && <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>Loading…</div>}

          {!loading && meta && (
            <>
              {/* Summary line */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10,
                marginBottom: 14, padding: 10,
                background: 'rgba(255,255,255,0.03)', borderRadius: 6,
                fontSize: 11,
              }}>
                <div>
                  <div style={{ color: '#888', fontSize: 9, letterSpacing: '0.06em' }}>NAV</div>
                  <div style={{ color: '#fff', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtUsd0(meta.nav)}
                  </div>
                </div>
                <div>
                  <div style={{ color: '#888', fontSize: 9, letterSpacing: '0.06em' }}>DIRECTION</div>
                  <div style={{ color: '#fff', fontWeight: 700 }}>{meta.direction}</div>
                </div>
                <div>
                  <div style={{ color: '#888', fontSize: 9, letterSpacing: '0.06em' }}>ORIGINAL STOP</div>
                  <div style={{ color: '#fff', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtUsd(meta.originalStop)}
                  </div>
                </div>
                <div>
                  <div style={{ color: '#888', fontSize: 9, letterSpacing: '0.06em' }}>L1 ANCHOR</div>
                  <div style={{ color: '#fff', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtUsd(meta.anchor)}
                  </div>
                </div>
              </div>

              {/* Per-lot table */}
              <table style={{
                width: '100%', borderCollapse: 'collapse', fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
              }}>
                <thead>
                  <tr style={{ color: '#888', textAlign: 'right' }}>
                    <th style={{ ...thStyle, textAlign: 'left' }}>LOT</th>
                    <th style={thStyle}>SHARES</th>
                    <th style={thStyle}>TRIGGER</th>
                    <th style={thStyle}>RISK / SH</th>
                    <th style={thStyle}>LOT RISK</th>
                    <th style={thStyle}>CUM SHS</th>
                    <th style={thStyle}>CUM RISK</th>
                    <th style={thStyle}>% NAV</th>
                  </tr>
                </thead>
                <tbody>
                  {(computed?.rows || []).map((r) => {
                    const isL1     = r.lot === 1;
                    const navHot   = r.cumRiskPctNav > 1.0;
                    const navWarn  = r.cumRiskPctNav > 0.75 && !navHot;
                    return (
                      <tr key={r.lot} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <td style={{ ...tdStyle, textAlign: 'left', color: isL1 ? '#7ed957' : '#FCF000', fontWeight: 700 }}>
                          L{r.lot} <span style={{ color: '#777', fontWeight: 400, marginLeft: 4 }}>{r.name}</span>
                          {isL1 && <span style={{ color: '#7ed957', fontSize: 9, marginLeft: 6 }}>FILLED</span>}
                        </td>
                        <td style={tdStyle}>
                          {isL1 ? (
                            <span style={{ color: '#fff', fontWeight: 600 }}>{r.shares}</span>
                          ) : (
                            <input
                              type="number"
                              min="0"
                              value={shares[r.lot]}
                              onChange={(e) => setShares(s => ({ ...s, [r.lot]: Math.max(0, Math.floor(+e.target.value || 0)) }))}
                              style={{
                                width: 60, padding: '3px 6px', textAlign: 'right',
                                background: 'rgba(255,255,255,0.05)',
                                border: '1px solid rgba(252,240,0,0.3)',
                                borderRadius: 3,
                                color: '#fff', fontFamily: 'inherit',
                                fontSize: 11, fontVariantNumeric: 'tabular-nums',
                              }}
                            />
                          )}
                        </td>
                        <td style={tdStyle}>{fmtUsd(r.triggerPrice)}</td>
                        <td style={{ ...tdStyle, color: '#aaa' }}>{fmtUsd(r.riskPerShare)}</td>
                        <td style={{ ...tdStyle, color: '#aaa' }}>{fmtUsd0(r.lotRisk)}</td>
                        <td style={{ ...tdStyle, color: '#fff', fontWeight: 600 }}>{r.cumShares}</td>
                        <td style={{ ...tdStyle, color: '#fff', fontWeight: 600 }}>{fmtUsd0(r.cumRisk)}</td>
                        <td style={{
                          ...tdStyle, fontWeight: 800,
                          color: navHot ? '#dc3545' : navWarn ? '#ffc107' : '#7ed957',
                        }}>
                          {fmtPct(r.cumRiskPctNav)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid rgba(252,240,0,0.4)', fontWeight: 800 }}>
                    <td style={{ ...tdStyle, textAlign: 'left', color: '#FCF000' }}>IF ALL FILL</td>
                    <td style={tdStyle}>—</td>
                    <td style={tdStyle}>—</td>
                    <td style={tdStyle}>—</td>
                    <td style={tdStyle}>—</td>
                    <td style={{ ...tdStyle, color: '#fff' }}>{totalShares}</td>
                    <td style={{ ...tdStyle, color: '#fff' }}>{fmtUsd0(totalRisk)}</td>
                    <td style={{
                      ...tdStyle,
                      color: overOnePct ? '#dc3545' : totalRiskPct > 0.75 ? '#ffc107' : '#7ed957',
                    }}>
                      {fmtPct(totalRiskPct)}
                    </td>
                  </tr>
                </tfoot>
              </table>

              {/* Risk warning */}
              {overOnePct && (
                <div style={{
                  marginTop: 10, padding: '8px 12px',
                  background: 'rgba(220,53,69,0.12)',
                  border: '1px solid rgba(220,53,69,0.5)',
                  borderRadius: 4, color: '#ff8888',
                  fontSize: 11, fontWeight: 600,
                }}>
                  ⚠ Total risk if all lots fill is {fmtPct(totalRiskPct)} of NAV — above the 1% PNTHR canonical risk frame. Make sure this is intentional.
                </div>
              )}

              {error && (
                <div style={{
                  marginTop: 10, padding: '8px 12px',
                  background: 'rgba(220,53,69,0.12)',
                  border: '1px solid rgba(220,53,69,0.5)',
                  borderRadius: 4, color: '#dc3545',
                  fontSize: 11, fontWeight: 600,
                }}>
                  {error}
                </div>
              )}

              {/* Actions */}
              <div style={{
                marginTop: 14, display: 'flex', gap: 8, justifyContent: 'space-between',
              }}>
                <button
                  onClick={dismiss}
                  disabled={submitting}
                  style={btnStyle('#444', '#ddd', submitting)}
                  title="Hide the PYRAMID button on this row going forward — for positions you've intentionally maxed out at single-shot size"
                >
                  DISMISS — POSITION IS FULL
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={onClose}
                    disabled={submitting}
                    style={btnStyle('transparent', '#aaa', submitting, '1px solid rgba(255,255,255,0.2)')}
                  >
                    CANCEL
                  </button>
                  <button
                    onClick={apply}
                    disabled={submitting || totalShares <= +meta.currentL1?.shares}
                    style={btnStyle('#FCF000', '#000', submitting || totalShares <= +meta.currentL1?.shares)}
                  >
                    {submitting ? 'APPLYING…' : 'APPLY PYRAMID PLAN'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const thStyle = {
  padding: '6px 8px',
  textAlign: 'right',
  fontWeight: 700,
  fontSize: 9,
  letterSpacing: '0.06em',
};
const tdStyle = {
  padding: '6px 8px',
  textAlign: 'right',
};
function btnStyle(bg, fg, disabled, border) {
  return {
    padding: '8px 14px',
    background: disabled ? '#333' : bg,
    color: disabled ? '#777' : fg,
    border: border || 'none',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.06em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
  };
}
