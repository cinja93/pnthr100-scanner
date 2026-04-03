// client/src/components/AssistantPage.jsx
// ── PNTHR Assistant — Daily Task Co-Pilot ─────────────────────────────────────
//
// Shows a sorted, prioritized task list so the user knows exactly what to do
// today, in order of urgency. P1=critical (red), P2=action (orange),
// P3=review (yellow), P4=routine (green).
//
// Sections:
//   1. Header (counts + refresh timer)
//   2. P1–P2 task cards (collapsible)
//   3. Stop Sync section (Mon = Stop Sync, other days = Stop Check)
//   4. P3 task cards
//   5. Routine checklist (collapsible)
//   6. Completed today (collapsed footer)
//
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useMemo } from 'react';
import { API_BASE, authHeaders, fetchIbkrDiscrepancies, fetchIbkrTradesToday } from '../services/api';
import ChartModal from './ChartModal';
import { useAnalyzeContext } from '../contexts/AnalyzeContext';
import { computeAnalyzeScore } from '../utils/analyzeScore';

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIORITY_COLOR = {
  1: '#dc3545',
  2: '#fd7e14',
  3: '#ffc107',
  4: '#28a745',
};

const PRIORITY_LABEL = {
  1: 'CRITICAL',
  2: 'ACTION',
  3: 'REVIEW',
  4: 'ROUTINE',
};

const REFRESH_INTERVAL = 60; // seconds between auto-refreshes

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n) {
  if (n == null) return 'N/A';
  return `$${Number(n).toFixed(2)}`;
}

function nowEtString() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month:   'short',
    day:     'numeric',
    hour:    'numeric',
    minute:  '2-digit',
    hour12:  true,
  }) + ' ET';
}

function dayLabel(dow) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow] || '';
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: {
    minHeight: '100vh',
    background: '#0d0d0d',
    color: '#e0e0e0',
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    padding: '20px 24px 60px',
    maxWidth: 900,
    margin: '0 auto',
  },

  // Header
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 24,
    flexWrap: 'wrap',
    gap: 12,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: '0.08em',
    color: '#FCF000',
    margin: 0,
  },
  headerMeta: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
  headerRight: {
    textAlign: 'right',
  },
  refreshBtn: {
    background: 'transparent',
    border: '1px solid #444',
    color: '#aaa',
    borderRadius: 4,
    padding: '5px 12px',
    fontSize: 11,
    cursor: 'pointer',
    letterSpacing: '0.05em',
  },
  refreshTimer: {
    fontSize: 11,
    color: '#555',
    marginTop: 4,
  },
  countBar: {
    display: 'flex',
    gap: 16,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  countPill: (color) => ({
    fontSize: 11,
    fontWeight: 700,
    color,
    background: `${color}18`,
    border: `1px solid ${color}44`,
    borderRadius: 12,
    padding: '3px 10px',
  }),

  // Section headers
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 28,
    marginBottom: 10,
    borderBottom: '1px solid #222',
    paddingBottom: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.12em',
    color: '#666',
    textTransform: 'uppercase',
  },

  // Task card
  card: (priority, expanded) => ({
    background: expanded ? '#161616' : '#111',
    border: `1px solid ${expanded ? '#2a2a2a' : '#1a1a1a'}`,
    borderLeft: `3px solid ${PRIORITY_COLOR[priority]}`,
    borderRadius: 6,
    marginBottom: 8,
    overflow: 'hidden',
    transition: 'background 0.15s',
  }),
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  badge: (priority) => ({
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '0.1em',
    color: PRIORITY_COLOR[priority],
    background: `${PRIORITY_COLOR[priority]}18`,
    border: `1px solid ${PRIORITY_COLOR[priority]}44`,
    borderRadius: 3,
    padding: '2px 7px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  }),
  ticker: {
    fontSize: 13,
    fontWeight: 700,
    color: '#FCF000',
    minWidth: 44,
    flexShrink: 0,
  },
  headline: {
    fontSize: 13,
    color: '#ccc',
    flex: 1,
    lineHeight: 1.4,
  },
  expandBtn: (expanded) => ({
    fontSize: 11,
    color: '#555',
    transform: expanded ? 'rotate(180deg)' : 'none',
    transition: 'transform 0.2s',
    flexShrink: 0,
  }),
  doneBtn: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: '#28a745',
    background: 'rgba(40,167,69,0.1)',
    border: '1px solid rgba(40,167,69,0.3)',
    borderRadius: 4,
    padding: '4px 10px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  doneTag: {
    fontSize: 10,
    fontWeight: 700,
    color: '#28a745',
    flexShrink: 0,
  },

  // Card body (expanded)
  cardBody: {
    padding: '0 14px 14px 14px',
    borderTop: '1px solid #1e1e1e',
  },
  instructions: {
    margin: '12px 0 0',
    padding: 0,
    listStyle: 'none',
  },
  instructionItem: {
    fontSize: 13,
    color: '#bbb',
    padding: '4px 0',
    lineHeight: 1.55,
    borderBottom: '1px solid #1a1a1a',
  },
  confirmRow: {
    marginTop: 14,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  confirmDoneBtn: {
    background: '#28a745',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '7px 18px',
    fontWeight: 700,
    fontSize: 12,
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },

  // Stop Sync section
  syncSection: {
    background: '#111',
    border: '1px solid #222',
    borderRadius: 6,
    marginTop: 20,
    marginBottom: 8,
    overflow: 'hidden',
  },
  syncHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: '1px solid #1e1e1e',
  },
  syncHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  syncLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: '#FCF000',
  },
  syncCount: {
    fontSize: 11,
    color: '#888',
  },
  syncRow: (needsUpdate) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '9px 14px',
    borderBottom: '1px solid #161616',
    background: needsUpdate ? 'rgba(220,53,69,0.04)' : 'transparent',
  }),
  syncCheck: (done) => ({
    width: 16,
    height: 16,
    borderRadius: 3,
    border: done ? '2px solid #28a745' : '2px solid #333',
    background: done ? '#28a745' : 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
  }),
  syncTicker: {
    width: 60,
    fontSize: 13,
    fontWeight: 700,
    color: '#FCF000',
  },
  syncDir: {
    width: 50,
    fontSize: 11,
    color: '#888',
  },
  syncStops: {
    flex: 1,
    fontSize: 12,
    color: '#ccc',
  },
  syncNeedsUpdate: {
    fontSize: 10,
    fontWeight: 700,
    color: '#fd7e14',
    background: 'rgba(253,126,20,0.1)',
    border: '1px solid rgba(253,126,20,0.3)',
    borderRadius: 3,
    padding: '2px 7px',
    whiteSpace: 'nowrap',
  },
  syncOk: {
    fontSize: 10,
    color: '#28a745',
    fontWeight: 700,
  },
  syncFooter: {
    padding: '10px 14px',
    borderTop: '1px solid #1e1e1e',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  syncAllBtn: {
    background: 'rgba(252,240,0,0.1)',
    color: '#FCF000',
    border: '1px solid rgba(252,240,0,0.3)',
    borderRadius: 4,
    padding: '6px 16px',
    fontWeight: 700,
    fontSize: 11,
    cursor: 'pointer',
    letterSpacing: '0.06em',
  },

  // Routine section
  routineSection: {
    background: '#111',
    border: '1px solid #222',
    borderRadius: 6,
    marginBottom: 8,
    overflow: 'hidden',
  },
  routineHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  routineLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: '#28a745',
  },
  routineItem: (done) => ({
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '9px 14px',
    borderTop: '1px solid #161616',
    cursor: 'pointer',
    background: done ? 'rgba(40,167,69,0.04)' : 'transparent',
  }),
  routineCheckbox: (done) => ({
    width: 16,
    height: 16,
    borderRadius: 3,
    border: done ? '2px solid #28a745' : '2px solid #333',
    background: done ? '#28a745' : 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  }),
  routineText: (done) => ({
    fontSize: 13,
    color: done ? '#555' : '#bbb',
    textDecoration: done ? 'line-through' : 'none',
  }),
  routineDetail: (done) => ({
    fontSize: 11,
    color: done ? '#444' : '#666',
    marginTop: 3,
    fontFamily: 'monospace',
    letterSpacing: '0.01em',
    lineHeight: 1.4,
    textDecoration: done ? 'line-through' : 'none',
    wordBreak: 'break-word',
  }),

  // Completed section
  completedSection: {
    marginTop: 28,
    background: '#0d0d0d',
    border: '1px solid #1a1a1a',
    borderRadius: 6,
    overflow: 'hidden',
  },
  completedHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  completedLabel: {
    fontSize: 11,
    color: '#555',
    letterSpacing: '0.08em',
  },
  completedItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 14px',
    borderTop: '1px solid #141414',
    fontSize: 12,
    color: '#444',
  },

  // Modal
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.75)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modal: {
    background: '#161616',
    border: '1px solid #333',
    borderRadius: 8,
    padding: 24,
    maxWidth: 480,
    width: '100%',
    boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: '#FCF000',
    marginBottom: 12,
    letterSpacing: '0.05em',
  },
  modalQuestion: {
    fontSize: 13,
    color: '#ccc',
    lineHeight: 1.5,
    marginBottom: 20,
  },
  modalButtons: {
    display: 'flex',
    gap: 10,
    justifyContent: 'flex-end',
  },
  modalYes: {
    background: '#28a745',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '9px 20px',
    fontWeight: 700,
    fontSize: 12,
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },
  modalNo: {
    background: 'transparent',
    color: '#888',
    border: '1px solid #333',
    borderRadius: 4,
    padding: '9px 16px',
    fontSize: 12,
    cursor: 'pointer',
  },

  empty: {
    color: '#444',
    fontSize: 13,
    padding: '18px 0',
    textAlign: 'center',
  },
  spinner: {
    textAlign: 'center',
    color: '#555',
    padding: 40,
    fontSize: 13,
  },
  error: {
    color: '#dc3545',
    background: 'rgba(220,53,69,0.08)',
    border: '1px solid rgba(220,53,69,0.2)',
    borderRadius: 6,
    padding: '12px 16px',
    fontSize: 13,
    marginBottom: 16,
  },

  // Command Health section
  healthSection: {
    background: '#111',
    border: '1px solid #1e1e1e',
    borderRadius: 6,
    marginBottom: 16,
    overflow: 'hidden',
  },
  healthHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: '1px solid #1e1e1e',
  },
  healthHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  healthLabel: {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.1em',
    color: '#FCF000',
  },
  healthCount: {
    fontSize: 11,
    color: '#555',
  },
  healthRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    borderBottom: '1px solid #161616',
    flexWrap: 'wrap',
    gap: 8,
  },
  healthRowLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  healthTicker: {
    fontSize: 13,
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '0.04em',
  },
  healthRsiValue: (alertType) => ({
    fontSize: 13,
    fontWeight: 800,
    color: alertType === 'BL_OVERBOUGHT' ? '#fd7e14' : '#ef5350',
  }),
  healthDelta: (positive) => ({
    fontSize: 11,
    color: positive ? '#ef5350' : '#28a745',
    fontWeight: 700,
  }),
  healthNote: (alertType) => ({
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.07em',
    color: alertType === 'BL_OVERBOUGHT' ? '#fd7e14' : '#ef5350',
    background: alertType === 'BL_OVERBOUGHT' ? 'rgba(253,126,20,0.1)' : 'rgba(239,83,80,0.1)',
    border: `1px solid ${alertType === 'BL_OVERBOUGHT' ? 'rgba(253,126,20,0.3)' : 'rgba(239,83,80,0.3)'}`,
    borderRadius: 4,
    padding: '2px 7px',
  }),
  healthAllClear: {
    padding: '12px 14px',
    fontSize: 12,
    color: '#28a745',
  },
  healthLoading: {
    padding: '12px 14px',
    fontSize: 12,
    color: '#555',
    fontStyle: 'italic',
  },
};

// ── Confirmation Modal ─────────────────────────────────────────────────────────

function ConfirmModal({ task, onConfirm, onCancel }) {
  return (
    <div style={s.modalOverlay} onClick={onCancel}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.modalTitle}>
          Mark "{task.badge}{task.ticker ? ` — ${task.ticker}` : ''}" as complete?
        </div>
        <div style={s.modalQuestion}>{task.confirmQuestion}</div>
        <div style={s.modalButtons}>
          <button style={s.modalNo}    onClick={onCancel}>NOT YET — KEEP OPEN</button>
          <button style={s.modalYes}   onClick={onConfirm}>YES — DONE ✓</button>
        </div>
      </div>
    </div>
  );
}

// ── Task Card ─────────────────────────────────────────────────────────────────

function TaskCard({ task, isCompleted, onMarkDone }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (isCompleted) {
    return (
      <div style={{ ...s.card(task.priority, expanded), opacity: 0.55 }}>
        <div style={s.cardHeader} onClick={() => setExpanded(e => !e)}>
          <span style={s.badge(task.priority)}>{task.badge}</span>
          {task.ticker && <span style={s.ticker}>{task.ticker}</span>}
          <span style={s.headline}>{task.headline}</span>
          <span style={s.expandBtn(expanded)}>▼</span>
          <span style={s.doneTag}>✓ DONE</span>
        </div>
        {expanded && (
          <div style={s.cardBody}>
            <ul style={s.instructions}>
              {(task.instructions || []).map((step, i) => (
                <li key={i} style={s.instructionItem}>{step}</li>
              ))}
            </ul>
            {(task.data?.longTickers?.length > 0 || task.data?.shortTickers?.length > 0) && (
              <div style={{ marginTop: 10, marginBottom: 4 }}>
                <div style={{ fontSize: 10, color: '#555', marginBottom: 6, letterSpacing: '0.06em', fontWeight: 700 }}>
                  POSITIONS IN THIS SECTOR
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {(task.data.longTickers || []).map(t => (
                    <span key={t + '_L'} style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 4,
                      background: 'rgba(40,167,69,0.13)', color: '#28a745',
                      border: '1px solid rgba(40,167,69,0.3)',
                    }}>
                      {t} <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7 }}>LONG</span>
                    </span>
                  ))}
                  {(task.data.shortTickers || []).map(t => (
                    <span key={t + '_S'} style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 4,
                      background: 'rgba(239,83,80,0.13)', color: '#ef5350',
                      border: '1px solid rgba(239,83,80,0.3)',
                    }}>
                      {t} <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7 }}>SHORT</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div style={s.card(task.priority, expanded)}>
        <div style={s.cardHeader} onClick={() => setExpanded(e => !e)}>
          <span style={s.badge(task.priority)}>{task.badge}</span>
          {task.ticker && <span style={s.ticker}>{task.ticker}</span>}
          <span style={s.headline}>{task.headline}</span>
          <span style={s.expandBtn(expanded)}>▼</span>
          <button
            style={s.doneBtn}
            onClick={e => { e.stopPropagation(); setConfirming(true); }}
          >
            DONE?
          </button>
        </div>

        {expanded && (
          <div style={s.cardBody}>
            <ul style={s.instructions}>
              {(task.instructions || []).map((step, i) => (
                <li key={i} style={s.instructionItem}>{step}</li>
              ))}
            </ul>

            {/* Sector ticker chips — shown when task.data has longTickers / shortTickers */}
            {(task.data?.longTickers?.length > 0 || task.data?.shortTickers?.length > 0) && (
              <div style={{ marginTop: 10, marginBottom: 4 }}>
                <div style={{ fontSize: 10, color: '#555', marginBottom: 6, letterSpacing: '0.06em', fontWeight: 700 }}>
                  POSITIONS IN THIS SECTOR
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {(task.data.longTickers || []).map(t => (
                    <span key={t + '_L'} style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 4,
                      background: 'rgba(40,167,69,0.13)', color: '#28a745',
                      border: '1px solid rgba(40,167,69,0.3)',
                    }}>
                      {t} <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7 }}>LONG</span>
                    </span>
                  ))}
                  {(task.data.shortTickers || []).map(t => (
                    <span key={t + '_S'} style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 4,
                      background: 'rgba(239,83,80,0.13)', color: '#ef5350',
                      border: '1px solid rgba(239,83,80,0.3)',
                    }}>
                      {t} <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7 }}>SHORT</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={s.confirmRow}>
              <button style={s.confirmDoneBtn} onClick={() => setConfirming(true)}>
                DONE ✓ — Mark Complete
              </button>
            </div>
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmModal
          task={task}
          onConfirm={() => { setConfirming(false); onMarkDone(task); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

// ── Stop Sync Row ─────────────────────────────────────────────────────────────

function StopSyncRow({ row, isDone, onToggle }) {
  const arrow = row.direction === 'LONG' ? '▲' : '▼';
  return (
    <div style={s.syncRow(row.needsUpdate && !isDone)}>
      <div
        style={s.syncCheck(isDone)}
        onClick={() => onToggle(row.ticker)}
        title={isDone ? 'Mark as not done' : 'Mark as done'}
      >
        {isDone && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
      </div>
      <span style={s.syncTicker}>{row.ticker}</span>
      <span style={s.syncDir}>{row.direction}</span>

      {/* PNTHR stored stop → signal-cache stop */}
      <span style={s.syncStops}>
        {fmt$(row.currentStop)}
        {row.signalNeedsUpdate && row.newStop != null && (
          <span style={{ color: '#fd7e14' }}> → {fmt$(row.newStop)}</span>
        )}
        {!row.signalNeedsUpdate && (
          <span style={{ color: '#444' }}> (PNTHR ✓)</span>
        )}
      </span>

      {/* IBKR live stop order — only shown when bridge has synced stop orders */}
      {row.ibkrStop != null && (
        <span style={{
          fontSize:   11,
          color:      row.ibkrMismatch ? '#ef5350' : '#28a745',
          fontWeight: row.ibkrMismatch ? 700 : 400,
          display:    'flex',
          alignItems: 'center',
          gap:        5,
        }}>
          IBKR {fmt$(row.ibkrStop)}
          {row.ibkrMismatch && (
            <span style={{
              fontSize:       9,
              fontWeight:     800,
              letterSpacing:  '0.06em',
              color:          '#ef5350',
              background:     'rgba(239,83,80,0.12)',
              border:         '1px solid rgba(239,83,80,0.35)',
              borderRadius:   4,
              padding:        '2px 6px',
              whiteSpace:     'nowrap',
            }}>
              ⚠ IBKR MISMATCH
            </span>
          )}
        </span>
      )}

      {row.needsUpdate && !isDone ? (
        <span style={s.syncNeedsUpdate}>
          {row.ibkrMismatch && !row.signalNeedsUpdate ? '⚠ IBKR drifted' : `${arrow} needs update`}
        </span>
      ) : (
        <span style={s.syncOk}>✓</span>
      )}
    </div>
  );
}

// ── Today's IBKR Trades Section ───────────────────────────────────────────────
// Shows every execution today categorized against Command positions so you can
// instantly see what auto-closed, what needs manual action, and what was traded
// outside of PNTHR tracking.

const TRADE_CAT = {
  AUTO_CLOSED:   { label: 'Auto-closed',     color: '#28a745', bg: 'rgba(40,167,69,0.08)'  },
  LOT_FILL:      { label: 'Lot fill',         color: '#4fc3f7', bg: 'rgba(79,195,247,0.08)' },
  NEW_POSITION:  { label: 'New position',     color: '#4fc3f7', bg: 'rgba(79,195,247,0.08)' },
  PARTIAL:       { label: 'Partial exit',     color: '#4fc3f7', bg: 'rgba(79,195,247,0.06)' },
  NEEDS_CLOSE:   { label: 'Still ACTIVE ⚠',  color: '#ff8c00', bg: 'rgba(255,140,0,0.10)'  },
  UNTRACKED:     { label: 'Untracked',        color: '#666',    bg: 'rgba(255,255,255,0.02)'},
  DAY_TRADE:     { label: 'Day trade',        color: '#888',    bg: 'rgba(255,255,255,0.02)'},
};

function formatExecTime(t) {
  // IBKR time format: "20250401  11:17:02"
  if (!t) return '';
  const parts = t.trim().split(/\s+/);
  return parts[parts.length - 1] || t; // just the HH:MM:SS part
}

// One-click sync button for PARTIAL exit rows.
// Updates Command's remainingShares AND marks the execId as processed so the
// button doesn't reappear on the next Trades Today poll.
function PartialSyncButton({ trade: t, onSynced }) {
  const [state, setState] = useState('idle'); // idle | syncing | done | error

  async function doSync() {
    if (!t.positionId || t.ibkrRemainingShares == null) return;
    setState('syncing');
    try {
      const res = await fetch(`${API_BASE}/api/ibkr/sync-partial`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positionId: t.positionId,
          execId: t.execId,
          remainingShares: t.ibkrRemainingShares,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      setState('done');
      setTimeout(() => onSynced(), 1200);
    } catch {
      setState('error');
    }
  }

  if (state === 'syncing') return <span style={{ fontSize: 10, color: '#888' }}>Syncing…</span>;
  if (state === 'done')    return <span style={{ fontSize: 10, color: '#28a745', fontWeight: 700 }}>✓ Synced to {t.ibkrRemainingShares} shr</span>;
  if (state === 'error')   return <span style={{ fontSize: 10, color: '#dc3545', cursor: 'pointer' }} onClick={doSync}>✗ Failed — retry</span>;

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 10, color: '#888' }}>{t.shares} of {t.pnthrFilledShares} shr</span>
      {t.positionId && t.ibkrRemainingShares != null && (
        <button
          onClick={doSync}
          style={{
            background: 'none', border: '1px solid #4fc3f7', color: '#4fc3f7',
            borderRadius: 3, padding: '1px 7px', fontSize: 10, cursor: 'pointer', fontWeight: 700,
          }}
        >
          Sync {t.ibkrRemainingShares} shr → Command
        </button>
      )}
    </span>
  );
}

function TradesTodaySection({ trades, loading, ibkrConnected, onNavigate }) {
  const [expanded, setExpanded] = useState(true);

  if (!ibkrConnected) return null;

  const needsClose  = trades.filter(t => t.category === 'NEEDS_CLOSE');
  const total       = trades.length;
  const headerColor = needsClose.length > 0 ? '#ff8c00' : total > 0 ? '#28a745' : '#444';

  return (
    <div style={{
      margin: '10px 10px 5px',
      borderRadius: 6,
      border: `1px solid ${needsClose.length > 0 ? '#ff8c0044' : '#1e1e1e'}`,
      background: '#0c0c0c',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', cursor: 'pointer', background: '#101010' }}
        onClick={() => setExpanded(e => !e)}
      >
        <span style={{ fontSize: 11, color: '#444' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 700, fontSize: 12, color: headerColor, letterSpacing: '0.04em' }}>
          📋 TODAY'S IBKR TRADES
        </span>
        <span style={{ fontSize: 11, color: '#555', marginLeft: 4 }}>
          {loading ? '(loading…)' : total === 0 ? '— no fills today' : `— ${total} fill${total !== 1 ? 's' : ''}`}
        </span>
        {/* Count pills */}
        {!loading && needsClose.length > 0 && (
          <span style={{ marginLeft: 'auto', background: '#ff8c00', color: '#000', borderRadius: 3, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>
            {needsClose.length} NEED{needsClose.length > 1 ? 'S' : ''} ACTION
          </span>
        )}
        {!loading && needsClose.length === 0 && total > 0 && (
          <span style={{ marginLeft: 'auto', color: '#28a745', fontSize: 11, fontWeight: 700 }}>✓ all reconciled</span>
        )}
      </div>

      {expanded && (
        loading ? (
          <div style={{ padding: '10px 14px', fontSize: 12, color: '#555' }}>Loading today's fills…</div>
        ) : total === 0 ? (
          <div style={{ padding: '10px 14px', fontSize: 12, color: '#444' }}>No IBKR fills recorded today</div>
        ) : (
          <div>
            {/* Column headers */}
            <div style={{ display: 'flex', gap: 8, padding: '5px 14px 4px', borderBottom: '1px solid #1a1a1a', fontSize: 10, color: '#444', letterSpacing: '0.05em' }}>
              <span style={{ width: 52, flexShrink: 0 }}>TIME</span>
              <span style={{ width: 52, flexShrink: 0 }}>TICKER</span>
              <span style={{ width: 36, flexShrink: 0 }}>SIDE</span>
              <span style={{ width: 44, flexShrink: 0, textAlign: 'right' }}>SHARES</span>
              <span style={{ width: 64, flexShrink: 0, textAlign: 'right' }}>PRICE</span>
              <span style={{ flex: 1 }}>STATUS</span>
            </div>

            {trades.map((t, i) => {
              const cat      = TRADE_CAT[t.category] || TRADE_CAT.UNTRACKED;
              const isSell   = t.side === 'SLD';
              const sideColor = isSell ? '#ef5350' : '#28a745';
              const sideLabel = isSell ? 'SELL' : 'BUY';

              return (
                <div key={t.execId || i} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 14px',
                  borderTop: i > 0 ? '1px solid #141414' : undefined,
                  background: cat.bg,
                }}>
                  {/* Time */}
                  <span style={{ width: 52, flexShrink: 0, fontSize: 11, color: '#555', fontFamily: 'monospace' }}>
                    {formatExecTime(t.time)}
                  </span>

                  {/* Ticker */}
                  <span style={{ width: 52, flexShrink: 0, fontWeight: 700, fontSize: 12, color: '#e0e0e0' }}>
                    {t.ticker}
                  </span>

                  {/* Side badge */}
                  <span style={{
                    width: 36, flexShrink: 0,
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                    color: sideColor,
                  }}>
                    {sideLabel}
                  </span>

                  {/* Shares */}
                  <span style={{ width: 44, flexShrink: 0, textAlign: 'right', fontSize: 12, color: '#ccc' }}>
                    {t.shares}
                  </span>

                  {/* Price */}
                  <span style={{ width: 64, flexShrink: 0, textAlign: 'right', fontSize: 12, color: '#bbb', fontFamily: 'monospace' }}>
                    ${(+t.price).toFixed(2)}
                  </span>

                  {/* Status + action */}
                  <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: cat.color,
                      letterSpacing: '0.04em',
                    }}>
                      {cat.label}
                    </span>

                    {t.category === 'NEEDS_CLOSE' && (
                      <>
                        {t.pnthrFilledShares != null && (
                          <span style={{ fontSize: 10, color: '#666' }}>
                            (PNTHR: {t.pnthrFilledShares} shr)
                          </span>
                        )}
                        <button
                          onClick={() => onNavigate('command')}
                          style={{
                            background: 'none', border: '1px solid #ff8c00', color: '#ff8c00',
                            borderRadius: 3, padding: '1px 8px', fontSize: 10, cursor: 'pointer', fontWeight: 700,
                          }}
                        >
                          Close in Command →
                        </button>
                      </>
                    )}

                    {t.category === 'PARTIAL' && t.pnthrFilledShares != null && (
                      <PartialSyncButton trade={t} onSynced={() => fetchIbkrTradesToday().then(d => setIbkrTrades(d.trades || [])).catch(() => {})} />
                    )}

                    {t.category === 'LOT_FILL' && (
                      <span style={{ fontSize: 10, color: '#666' }}>added to position</span>
                    )}

                    {t.category === 'NEW_POSITION' && (
                      <span style={{ fontSize: 10, color: '#666' }}>new position created</span>
                    )}

                    {t.category === 'UNTRACKED' && (
                      <span style={{ fontSize: 10, color: '#555' }}>not tracked in Command</span>
                    )}

                    {t.category === 'DAY_TRADE' && (
                      <span style={{ fontSize: 10, color: '#666' }}>opened &amp; closed same day</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

// ── IBKR Discrepancy Section ──────────────────────────────────────────────────
// Shows all active IBKR ↔ Command mismatches: missing tickers, shares mismatch,
// price mismatch, missing/mismatched stops. Updated on each Assistant refresh.

const DISC_SEVERITY_COLOR = { CRITICAL: '#dc3545', HIGH: '#ff8c00', MEDIUM: '#ffc107' };
const DISC_SEVERITY_BG    = {
  CRITICAL: 'rgba(220,53,69,0.10)',
  HIGH:     'rgba(255,140,0,0.08)',
  MEDIUM:   'rgba(255,193,7,0.06)',
};
const DISC_SEVERITY_ICON  = { CRITICAL: '🚨', HIGH: '⚠️', MEDIUM: 'ℹ️' };

function IbkrDiscrepancySection({ discrepancies, loading, ibkrConnected }) {
  const [expanded, setExpanded] = useState(true);

  const critCount = discrepancies.filter(d => d.severity === 'CRITICAL').length;
  const highCount  = discrepancies.filter(d => d.severity === 'HIGH').length;
  const total      = discrepancies.length;

  // Header color: red if any critical, orange if any high, yellow otherwise
  const headerColor = critCount > 0 ? '#dc3545' : highCount > 0 ? '#ff8c00' : '#ffc107';

  if (!ibkrConnected) return null; // IBKR not synced — no section

  return (
    <div style={{
      margin: '10px 10px 5px',
      borderRadius: 6,
      border: `1px solid ${total > 0 ? headerColor + '44' : '#1e3a1e'}`,
      background: '#0c0c0c',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', cursor: 'pointer', background: '#101010' }}
        onClick={() => setExpanded(e => !e)}
      >
        <span style={{ fontSize: 11, color: '#444' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 700, fontSize: 12, color: total > 0 ? headerColor : '#28a745', letterSpacing: '0.04em' }}>
          🔗 IBKR DISCREPANCY CHECK
        </span>
        <span style={{ fontSize: 11, color: '#666', marginLeft: 4 }}>
          {loading ? '(checking…)' : total === 0 ? '— all clear ✓' : `— ${total} issue${total !== 1 ? 's' : ''}`}
        </span>
        {!loading && critCount > 0 && (
          <span style={{ marginLeft: 'auto', background: '#dc3545', color: '#fff', borderRadius: 3, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>
            {critCount} CRITICAL
          </span>
        )}
      </div>

      {expanded && (
        loading ? (
          <div style={{ padding: '10px 14px', fontSize: 12, color: '#555' }}>Checking IBKR vs Command…</div>
        ) : total === 0 ? (
          <div style={{ padding: '10px 14px', fontSize: 12, color: '#28a745' }}>
            ✓ All positions match — no discrepancies found
          </div>
        ) : (
          <div>
            {discrepancies.map((d, i) => {
              const color = DISC_SEVERITY_COLOR[d.severity] || '#ffc107';
              const bg    = DISC_SEVERITY_BG[d.severity]    || 'rgba(255,193,7,0.06)';
              const icon  = DISC_SEVERITY_ICON[d.severity]  || '⚠️';
              return (
                <div key={i} style={{
                  borderTop: i > 0 ? '1px solid #191919' : undefined,
                  padding: '9px 14px',
                  background: bg,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                }}>
                  <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>{icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, fontSize: 12, color, letterSpacing: '0.03em' }}>
                        {d.severity}
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 12, color: '#e0e0e0' }}>{d.ticker}</span>
                      <span style={{
                        background: '#222',
                        color: '#888',
                        borderRadius: 3,
                        padding: '1px 5px',
                        fontSize: 10,
                        letterSpacing: '0.04em',
                      }}>
                        {d.type.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: '#bbb', lineHeight: 1.4 }}>{d.message}</div>
                    {/* Extra detail for specific types */}
                    {d.type === 'SHARES_MISMATCH' && (
                      <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>
                        Command: <b style={{ color: '#ddd' }}>{d.pnthrShares} shr</b> · IBKR: <b style={{ color: '#ddd' }}>{d.ibkrShares} shr</b>
                        {' '}— Update Command lot shares to match IBKR
                      </div>
                    )}
                    {d.type === 'PRICE_MISMATCH' && (
                      <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>
                        Command avg: <b style={{ color: '#ddd' }}>${d.pnthrAvg?.toFixed(2)}</b> · IBKR avg: <b style={{ color: '#ddd' }}>${d.ibkrAvg?.toFixed(2)}</b>
                        {' '}· Diff: <b style={{ color }}>{d.diffPct}%</b>
                      </div>
                    )}
                    {d.type === 'STOP_MISSING' && d.ibkrStop && (
                      <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>
                        IBKR has a stop order at <b style={{ color: '#ddd' }}>${(+d.ibkrStop).toFixed(2)}</b> — add this stop to Command now
                      </div>
                    )}
                    {d.type === 'STOP_MISMATCH' && (
                      <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>
                        Command: <b style={{ color: '#ddd' }}>${d.pnthrStop?.toFixed(2)}</b> · IBKR order: <b style={{ color: '#ddd' }}>${d.ibkrStop?.toFixed(2)}</b>
                        {' '}· Diff: <b style={{ color }}>${Math.abs(d.diff || 0).toFixed(2)}</b>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

// ── Command Health Section ────────────────────────────────────────────────────
// Shows daily RSI alerts for every active Command position.
// BL > 75 = overbought / FEAST zone. SS < 25 = oversold / short squeeze risk.

// ── RsiGauge — compact horizontal bar showing RSI position relative to 25/75 zone ──
// Bar spans 0–100. Green zone: 25–75. Tick marks actual RSI value.
// Color logic is direction-aware:
//   BL: tick > 75 = amber warning, tick < 25 = blue (favorable oversold)
//   SS: tick < 25 = amber warning, tick > 75 = blue (favorable overbought)
function RsiGauge({ rsi, direction }) {
  const isBL      = direction === 'BL';
  const isInZone  = rsi >= 25 && rsi <= 75;
  const isWarning = (isBL && rsi > 75) || (!isBL && rsi < 25);
  const tickColor = isInZone  ? '#28a745'
                  : isWarning ? '#ff9800'
                  : '#4fc3f7'; // favorable (oversold long / overbought short)
  const tickPct   = Math.max(0, Math.min(100, rsi));

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
      {/* Left label — 25 */}
      <span style={{ fontSize: 9, color: '#3a3a3a', minWidth: 14, textAlign: 'right', flexShrink: 0 }}>25</span>

      {/* Track */}
      <div style={{ position: 'relative', height: 8, flex: 1, background: '#1c1c1c', borderRadius: 3, minWidth: 80 }}>
        {/* Normal zone highlight 25%–75% */}
        <div style={{
          position: 'absolute', left: '25%', width: '50%', height: '100%',
          background: 'rgba(40,167,69,0.12)', borderRadius: 2,
        }} />
        {/* Zone boundary lines */}
        <div style={{ position: 'absolute', left: '25%', top: 0, width: 1, height: '100%', background: 'rgba(40,167,69,0.25)' }} />
        <div style={{ position: 'absolute', left: '75%', top: 0, width: 1, height: '100%', background: 'rgba(40,167,69,0.25)' }} />
        {/* RSI tick — slightly taller than track for visibility */}
        <div style={{
          position:  'absolute',
          left:      `${tickPct}%`,
          top:       -2, bottom: -2,
          width:     2,
          background: tickColor,
          borderRadius: 1,
          transform: 'translateX(-50%)',
          boxShadow: `0 0 3px ${tickColor}88`,
        }} />
      </div>

      {/* Right label — 75 */}
      <span style={{ fontSize: 9, color: '#3a3a3a', minWidth: 14, flexShrink: 0 }}>75</span>
    </div>
  );
}

// ── rsiTickColor — direction-aware color for RSI tick ────────────────────────
function rsiTickColor(rsi, direction) {
  const isBL      = direction === 'BL';
  const isInZone  = rsi >= 25 && rsi <= 75;
  const isWarning = (isBL && rsi > 75) || (!isBL && rsi < 25);
  return isInZone ? '#28a745' : isWarning ? '#ff9800' : '#4fc3f7';
}

// ── RsiGaugeRow — card per position with daily + weekly gauge bars ────────────
//   Left accent border is direction-colored (green=LONG, red=SHORT).
//   Bars are width-capped so ticks are easy to spot.
//   D = daily RSI-14 (updates each market close)
//   W = weekly RSI-14 (updates once per week)
function RsiGaugeRow({ pos }) {
  const isBL     = pos.direction === 'BL';
  const dirLabel = isBL ? 'LONG' : 'SHORT';
  const dirColor = isBL ? '#28a745' : '#ef5350';

  // Daily
  const dailyColor = rsiTickColor(pos.rsi, pos.direction);
  const dailyAlert = pos.alertType === 'BL_OVERBOUGHT' ? '⚠ FEAST'
                   : pos.alertType === 'SS_OVERSOLD'    ? '⚠ SQUEEZE'
                   : null;
  const dailyDelta = pos.delta != null ? `${pos.delta > 0 ? '+' : ''}${pos.delta}` : null;

  // Weekly
  const hasWeekly   = pos.weeklyRsi != null;
  const weeklyColor = hasWeekly ? rsiTickColor(pos.weeklyRsi, pos.direction) : '#333';
  const weeklyAlert = pos.weeklyAlertType === 'BL_OVERBOUGHT' ? '⚠ FEAST'
                    : pos.weeklyAlertType === 'SS_OVERSOLD'    ? '⚠ SQUEEZE'
                    : null;
  const weeklyDelta = pos.weeklyDelta != null ? `${pos.weeklyDelta > 0 ? '+' : ''}${pos.weeklyDelta}` : null;

  return (
    <div style={{
      margin: '0 10px 5px',
      borderRadius: 5,
      border: '1px solid #222',
      borderLeft: `3px solid ${dirColor}44`,
      background: '#0c0c0c',
      padding: '7px 10px 7px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>

        {/* ── Left: ticker + direction badge, fixed width ── */}
        <div style={{ width: 68, flexShrink: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#d0d0d0', letterSpacing: '0.02em', marginBottom: 3 }}>
            {pos.ticker}
          </div>
          <span style={{
            display: 'inline-block',
            fontSize: 8, fontWeight: 800, padding: '1px 6px', borderRadius: 3,
            background: isBL ? 'rgba(40,167,69,0.12)' : 'rgba(239,83,80,0.12)',
            color: dirColor,
            border: `1px solid ${isBL ? 'rgba(40,167,69,0.3)' : 'rgba(239,83,80,0.3)'}`,
            letterSpacing: '0.07em',
          }}>
            {dirLabel}
          </span>
        </div>

        {/* ── Right: stacked D + W gauge rows ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>

          {/* Daily */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: '#444', width: 12, flexShrink: 0 }}>D</span>
            {/* Bar capped at 260px so ticks don't get lost on wide screens */}
            <div style={{ flex: 1, maxWidth: 260, minWidth: 60 }}>
              <RsiGauge rsi={pos.rsi} direction={pos.direction} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: dailyColor, width: 52, textAlign: 'right', flexShrink: 0 }}>
              {pos.rsi}
            </span>
            <span style={{ fontSize: 9, color: pos.delta > 0 ? '#c0392b' : '#2e86c1', width: 32, textAlign: 'right', flexShrink: 0 }}>
              {dailyDelta || ''}
            </span>
            {dailyAlert && (
              <span style={{ fontSize: 9, color: '#ff9800', marginLeft: 4, flexShrink: 0 }}>{dailyAlert}</span>
            )}
          </div>

          {/* Weekly */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: '#444', width: 12, flexShrink: 0 }}>W</span>
            <div style={{ flex: 1, maxWidth: 260, minWidth: 60 }}>
              {hasWeekly
                ? <RsiGauge rsi={pos.weeklyRsi} direction={pos.direction} />
                : <div style={{ height: 8, background: '#181818', borderRadius: 3 }} />
              }
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: weeklyColor, width: 52, textAlign: 'right', flexShrink: 0 }}>
              {hasWeekly ? pos.weeklyRsi : <span style={{ color: '#2a2a2a' }}>—</span>}
            </span>
            <span style={{ fontSize: 9, color: pos.weeklyDelta > 0 ? '#c0392b' : '#2e86c1', width: 32, textAlign: 'right', flexShrink: 0 }}>
              {weeklyDelta || ''}
            </span>
            {weeklyAlert && (
              <span style={{ fontSize: 9, color: '#ff9800', marginLeft: 4, flexShrink: 0 }}>{weeklyAlert}</span>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

function CommandHealthSection({ positions, loading }) {
  const [expanded, setExpanded] = useState(false);
  const total      = positions?.length ?? 0;
  const alertCount = positions?.filter(p => p.isAlert).length ?? 0;

  // Summary text shown in header when collapsed (or while loading)
  const summaryText = loading
    ? 'loading…'
    : total === 0
      ? 'no positions'
      : alertCount > 0
        ? `${total} position${total !== 1 ? 's' : ''} · ${alertCount} alert${alertCount !== 1 ? 's' : ''}`
        : `${total} position${total !== 1 ? 's' : ''} · all clear`;

  const summaryColor = loading || alertCount === 0 ? '#555' : '#ff9800';

  return (
    <div style={s.healthSection}>
      <div style={s.healthHeader} onClick={() => setExpanded(e => !e)}>
        <div style={s.healthHeaderLeft}>
          <span style={{ fontSize: 11, color: '#444' }}>{expanded ? '▼' : '▶'}</span>
          <span style={s.healthLabel}>COMMAND HEALTH</span>
          <span style={{ ...s.healthCount, color: summaryColor }}>
            ({summaryText})
          </span>
        </div>
      </div>
      {expanded && (
        loading
          ? <div style={s.healthLoading}>Checking RSI for all Command positions…</div>
          : total === 0
            ? <div style={s.healthAllClear}>No active Command positions to display</div>
            : <div style={{ paddingTop: 6, paddingBottom: 4 }}>
                {positions.map(pos => <RsiGaugeRow key={pos.ticker + pos.direction} pos={pos} />)}
              </div>
      )}
    </div>
  );
}

// ── Recent Fills Section ──────────────────────────────────────────────────────

function fmtFillTime(closedAt) {
  if (!closedAt) return null;
  const d = new Date(closedAt);
  if (isNaN(d)) return null;
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
  if (isToday)     return `Today · ${time} ET`;
  if (isYesterday) return `Yesterday · ${time} ET`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) + ` · ${time} ET`;
}

// ── DismissBox — faded checkbox that removes a fill row when clicked ──────────
function DismissBox({ onDismiss }) {
  const [hover, setHover] = useState(false);
  const [checked, setChecked] = useState(false);
  const handleClick = () => {
    setChecked(true);
    // Brief flash of the checkmark before the row disappears
    setTimeout(onDismiss, 300);
  };
  return (
    <button
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Mark as reviewed — removes from this list"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, flexShrink: 0,
        background: 'transparent',
        border: `1px solid ${checked ? '#3a6b3a' : hover ? '#3a5a3a' : '#252525'}`,
        borderRadius: 4, cursor: 'pointer',
        color: checked ? '#4caf50' : hover ? '#3a6b3a' : '#333',
        fontSize: 13, transition: 'all 0.15s ease',
      }}
    >
      ✓
    </button>
  );
}

function RecentFillsSection({ fills, onNavigate }) {
  const [expanded,   setExpanded]   = useState(true);
  // Track which positionIds have been dismissed locally so the row vanishes
  // immediately without waiting for the next data fetch.
  const [dismissed, setDismissed] = useState(new Set());

  const handleDismiss = async (positionId) => {
    // Optimistic: remove from view right away
    setDismissed(prev => new Set([...prev, positionId]));
    try {
      await fetch(`${API_BASE}/api/assistant/dismiss-fill`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId }),
      });
    } catch { /* non-fatal — will still fall off after 48h */ }
  };

  const visible = (fills || []).filter(f => !dismissed.has(f.id));
  if (!visible.length) return null;

  return (
    <div style={{
      background: '#0d1a0d',
      border: '1px solid #1a4a1a',
      borderRadius: 8,
      marginBottom: 12,
      overflow: 'hidden',
    }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', cursor: 'pointer',
          borderBottom: expanded ? '1px solid #1a4a1a' : 'none',
        }}
      >
        <span style={{ fontSize: 11, color: '#555' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#4caf50', letterSpacing: 1 }}>
          ⚡ RECENT FILLS
        </span>
        <span style={{ fontSize: 11, color: '#555' }}>
          ({visible.length} position{visible.length !== 1 ? 's' : ''} auto-closed by IBKR)
        </span>
      </div>
      {expanded && visible.map(fill => {
        const outcome  = fill.outcome || {};
        const isProfit = (outcome.profitDollar ?? 0) >= 0;
        const pnlColor = isProfit ? '#4caf50' : '#dc3545';
        const pnlSign  = isProfit ? '+' : '';
        const fillTime = fmtFillTime(fill.closedAt);
        return (
          <div key={fill.id || fill.ticker} style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
            padding: '12px 16px', borderBottom: '1px solid #111',
          }}>
            <span style={{ fontWeight: 700, color: '#fcf000', fontSize: 13, minWidth: 60 }}>
              {fill.ticker}
            </span>
            <span style={{ fontSize: 11, color: '#888', minWidth: 50 }}>
              {fill.direction}
            </span>
            <span style={{ fontSize: 12, color: '#ccc' }}>
              Exit: <strong style={{ color: '#fff' }}>${outcome.exitPrice?.toFixed(2) ?? '—'}</strong>
            </span>
            <span style={{
              fontSize: 11, fontWeight: 700, color: '#fff',
              background: outcome.exitReason === 'STOP_HIT' ? '#7b2e2e' : '#2e4a7b',
              borderRadius: 4, padding: '2px 7px',
            }}>
              {outcome.exitReason === 'STOP_HIT' ? 'STOP HIT' : 'MANUAL EXIT'}
            </span>
            <span style={{ fontSize: 12, color: pnlColor, fontWeight: 600 }}>
              {pnlSign}${Math.abs(outcome.profitDollar ?? 0).toFixed(0)}
              {' '}({pnlSign}{(outcome.profitPct ?? 0).toFixed(2)}%)
            </span>
            {fillTime && (
              <span style={{ fontSize: 11, color: '#666' }}>
                {fillTime}
              </span>
            )}
            <button
              onClick={() => onNavigate?.('journal', { filter: 'CLOSED', focusId: fill.id, focusTicker: fill.ticker })}
              style={{
                marginLeft: 'auto', fontSize: 11, color: '#f5a623',
                background: '#2a1e0a', border: '1px solid #7a4a0a',
                borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
                fontWeight: 600, letterSpacing: '0.03em',
              }}
            >
              📋 Review journal entry
            </button>
            <DismissBox onDismiss={() => handleDismiss(fill.id)} />
          </div>
        );
      })}
      <div style={{ padding: '10px 16px', fontSize: 11, color: '#555' }}>
        Position closed automatically when TWS fill was detected. Click ✓ to dismiss, or fills auto-expire after 48 hours.
      </div>
    </div>
  );
}

// ── Chip Section ──────────────────────────────────────────────────────────────

function ChipSection({ section, onChipClick, busyTicker }) {
  return (
    <div style={{
      padding: '10px 14px 12px',
      borderTop: '1px solid #1a1a1a',
      background: '#0f0f0f',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 10,
          fontWeight: 800,
          color: section.direction === 'BL' ? '#28a745' : section.direction === 'SS' ? '#ef5350' : '#888',
          letterSpacing: '0.08em',
        }}>
          {section.title}
        </span>
      </div>
      {section.subtitle && (
        <div style={{ fontSize: 10, color: '#444', marginBottom: 8, fontStyle: 'italic' }}>
          {section.subtitle}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {section.chips.map(chip => {
          const isBL      = chip.direction === 'BL';
          const isBusy    = busyTicker === chip.ticker;
          const pct       = chip.analyzePct ?? null;
          // Analyze score color: green ≥ 90%, yellow 80-89%
          const pctColor  = pct != null ? (pct >= 90 ? '#28a745' : '#FFD700') : '#555';
          return (
            <button
              key={chip.ticker}
              onClick={(e) => { e.stopPropagation(); onChipClick(chip); }}
              disabled={isBusy}
              title={`${chip.ticker} — Kill #${chip.rank ?? '?'} · Kill ${chip.score} · ${chip.tier}${pct != null ? ' · Analyze ' + pct + '%' : ''} · ${chip.price != null ? '$' + chip.price : ''}`}
              style={{
                background:   isBL ? 'rgba(40,167,69,0.10)' : 'rgba(239,83,80,0.10)',
                border:       `1px solid ${isBL ? 'rgba(40,167,69,0.35)' : 'rgba(239,83,80,0.35)'}`,
                borderRadius:  6,
                padding:       '5px 10px',
                cursor:        isBusy ? 'wait' : 'pointer',
                display:       'flex',
                alignItems:    'center',
                gap:           5,
                opacity:       isBusy ? 0.6 : 1,
                transition:    'opacity 0.15s',
              }}
            >
              <span style={{ fontWeight: 800, fontSize: 12, color: '#fff', letterSpacing: '0.03em' }}>
                {chip.ticker}
              </span>
              {chip.rank != null && (
                <span style={{ fontSize: 10, color: '#555' }}>#{chip.rank}</span>
              )}
              <span style={{ fontSize: 10, color: '#fcf000', fontWeight: 700 }}>{chip.score}</span>
              <span style={{
                fontSize: 9,
                color: isBL ? '#28a745' : '#ef5350',
                fontWeight: 700,
                letterSpacing: '0.05em',
              }}>
                {chip.tier}
              </span>
              {pct != null && (
                <span style={{ fontSize: 10, fontWeight: 700, color: pctColor }}>
                  {pct}%
                </span>
              )}
              {chip.price != null && (
                <span style={{ fontSize: 10, color: '#666' }}>${chip.price}</span>
              )}
              <span style={{ fontSize: 9, color: '#333' }}>↗</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Routine Checklist ─────────────────────────────────────────────────────────

function RoutineSection({ routines, dayLabel: dayLabelStr, completedIds, onToggle, onChipClick, busyTicker }) {
  const [expanded, setExpanded] = useState(true);
  const doneCount = routines.filter(r => completedIds.has(r.id)).length;

  return (
    <div style={s.routineSection}>
      <div style={s.routineHeader} onClick={() => setExpanded(e => !e)}>
        <span style={s.routineLabel}>{dayLabelStr} ROUTINE ({routines.length} tasks · {doneCount} done)</span>
        <span style={{ fontSize: 11, color: '#444' }}>{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && routines.map(r => (
        <div key={r.id}>
          <div style={s.routineItem(completedIds.has(r.id))} onClick={() => onToggle(r.id)}>
            <div style={s.routineCheckbox(completedIds.has(r.id))}>
              {completedIds.has(r.id) && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
            </div>
            <div style={{ flex: 1 }}>
              <div style={s.routineText(completedIds.has(r.id))}>{r.label}</div>
              {r.detail && <div style={s.routineDetail(completedIds.has(r.id))}>{r.detail}</div>}
            </div>
          </div>
          {/* Chip sections — always visible so picks are accessible even after checking off */}
          {r.chipSections?.length > 0 && r.chipSections.map((section, si) => (
            <ChipSection
              key={si}
              section={section}
              onChipClick={onChipClick}
              busyTicker={busyTicker}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Completed Footer ──────────────────────────────────────────────────────────

function CompletedSection({ completed }) {
  const [expanded, setExpanded] = useState(false);
  if (!completed.length) return null;

  return (
    <div style={s.completedSection}>
      <div style={s.completedHeader} onClick={() => setExpanded(e => !e)}>
        <span style={s.completedLabel}>Done today ({completed.length})</span>
        <span style={{ fontSize: 11, color: '#333' }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && completed.map((c, i) => (
        <div key={i} style={s.completedItem}>
          <span style={{ color: '#28a745' }}>✓</span>
          <span>{c.taskType || 'ROUTINE'}</span>
          {c.ticker && <span style={{ color: '#FCF000', fontWeight: 700 }}>{c.ticker}</span>}
          <span style={{ color: '#333', marginLeft: 'auto', fontSize: 11 }}>
            {new Date(c.completedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Headline Feed ────────────────────────────────────────────────────────────
// Bloomberg-style scrolling alert feed. Polls /api/assistant/headlines every 60s.
// Developing signals cached 15 min server-side.

const HL = {
  CRITICAL:   { bg: '#1a0000', text: '#ffcdd2', ticker: '#ff6b6b', badge: '#b71c1c', badgeText: '#fff',    border: '#d32f2f' },
  HIGH:       { bg: '#1a0f00', text: '#ffe0b2', ticker: '#ffb74d', badge: '#4a2600', badgeText: '#ffb74d', border: '#e65100' },
  SIGNAL:     { bg: '#0a1a00', text: '#c5e1a5', ticker: '#FCF000', badge: '#1b5e20', badgeText: '#a5d6a7', border: '#4caf50' },
  MEDIUM:     { bg: '#1a1500', text: '#fff9c4', ticker: '#ffd54f', badge: '#3e2723', badgeText: '#ffe082', border: '#f9a825' },
  DEVELOPING: { bg: '#0a1520', text: '#b3d9ff', ticker: '#64b5f6', badge: '#0d2137', badgeText: '#90caf9', border: '#1976d2' },
  WATCHING:   { bg: '#12161a', text: '#90a4ae', ticker: '#b0bec5', badge: '#1c2530', badgeText: '#78909c', border: '#455a64' },
  LOW:        { bg: '#0d0d0d', text: '#616161', ticker: '#757575', badge: '#1a1a1a', badgeText: '#616161', border: '#333'    },
};

// Categories that should be grouped into a single collapsible row
const GROUP_CATS = new Set(['TRIGGERED_BL', 'TRIGGERED_SS', 'DEV_BL', 'DEV_SS']);
const GROUP_LABELS = {
  TRIGGERED_BL: 'NEW BL SIGNALS',
  TRIGGERED_SS: 'NEW SS SIGNALS',
  DEV_BL:       'Developing BL',
  DEV_SS:       'Developing SS',
};

function HeadlineFeed({ headlines, loading, devSignalsAge, onTickerClick, analyzeCtx }) {
  const [expanded, setExpanded] = useState(true);
  const [dismissedIds, setDismissedIds] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [clickedTickers, setClickedTickers] = useState(new Set()); // tickers user has opened

  const visible = headlines.filter(h => !dismissedIds.has(h.id));
  const count = visible.length;

  const fmtTime = (iso) => {
    if (!iso) return '--:--';
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  };

  // Build grouped + ungrouped items in display order, sorted by Analyze score
  const { rows, groupCounts } = useMemo(() => {
    const groups = {};  // category → [headline, ...]
    for (const h of visible) {
      if (GROUP_CATS.has(h.category)) {
        if (!groups[h.category]) groups[h.category] = [];
        groups[h.category].push(h);
      }
    }
    // Score and sort each group by Analyze score (highest first)
    for (const [cat, items] of Object.entries(groups)) {
      const direction = (cat === 'TRIGGERED_SS' || cat === 'DEV_SS') ? 'SS' : 'BL';
      for (const h of items) {
        let pct = 0;
        if (analyzeCtx) {
          try {
            const stockObj = {
              ticker: h.ticker,
              signal: direction,
              sector: h.sector || '',
              currentPrice: h.price || 0,
              totalScore: h.killScore || 0,
              killScore: h.killScore || 0,
            };
            const result = computeAnalyzeScore(stockObj, analyzeCtx);
            pct = result?.pct ?? 0;
          } catch { /* non-fatal */ }
        }
        h._analyzePct = pct;
      }
      items.sort((a, b) => (b._analyzePct || 0) - (a._analyzePct || 0));
    }
    // Build final rows: ungrouped items stay as-is, groups become a single entry
    const rows = [];
    const seenGroups = new Set();
    for (const h of visible) {
      if (GROUP_CATS.has(h.category)) {
        if (!seenGroups.has(h.category)) {
          seenGroups.add(h.category);
          rows.push({ type: 'group', category: h.category, items: groups[h.category] });
        }
      } else {
        rows.push({ type: 'single', item: h });
      }
    }
    return { rows, groupCounts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])) };
  }, [visible, analyzeCtx]);

  const critCount = visible.filter(h => h.urgency === 'CRITICAL').length;
  const highCount = visible.filter(h => h.urgency === 'HIGH').length;
  const sigCount  = (groupCounts.TRIGGERED_BL || 0) + (groupCounts.TRIGGERED_SS || 0);
  const devBLCount = groupCounts.DEV_BL || 0;
  const devSSCount = groupCounts.DEV_SS || 0;
  const devCount   = devBLCount + devSSCount;
  const watchCount = visible.filter(h => h.urgency === 'WATCHING').length;

  return (
    <div style={{
      background: '#080808',
      border: '1px solid #1a1a1a',
      borderRadius: 6,
      marginBottom: 16,
      overflow: 'hidden',
    }}>
      {/* Feed header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          background: '#0e0e0e',
          borderBottom: expanded ? '1px solid #1a1a1a' : 'none',
          padding: '8px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{ color: '#FCF000', fontWeight: 800, fontSize: 10, letterSpacing: '0.12em' }}>
          LIVE FEED
        </span>
        <span style={{
          display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
          background: loading ? '#ffc107' : count > 0 ? '#4caf50' : '#555',
          animation: loading ? 'none' : 'pulse-dot 2s ease-in-out infinite',
          flexShrink: 0,
        }} />

        {critCount > 0 && (
          <span style={{ background: '#b71c1c', color: '#fff', padding: '1px 7px', borderRadius: 3, fontSize: 9, fontWeight: 800, letterSpacing: '0.03em' }}>
            {critCount} CRITICAL
          </span>
        )}
        {highCount > 0 && (
          <span style={{ background: '#4a2600', color: '#ffb74d', padding: '1px 7px', borderRadius: 3, fontSize: 9, fontWeight: 700 }}>
            {highCount} HIGH
          </span>
        )}
        {sigCount > 0 && (
          <span style={{ background: '#1b5e20', color: '#a5d6a7', padding: '1px 7px', borderRadius: 3, fontSize: 9, fontWeight: 700 }}>
            {sigCount} SIGNAL
          </span>
        )}
        {devCount > 0 && (
          <span style={{ background: '#0d2137', color: '#90caf9', padding: '1px 7px', borderRadius: 3, fontSize: 9, fontWeight: 700 }}>
            {devCount} DEV ({devBLCount} BL · {devSSCount} SS)
          </span>
        )}
        {watchCount > 0 && (
          <span style={{ background: '#1c2530', color: '#78909c', padding: '1px 7px', borderRadius: 3, fontSize: 9, fontWeight: 600 }}>
            {watchCount} WATCH
          </span>
        )}

        <span style={{ color: '#444', fontSize: 9, marginLeft: 'auto', fontFamily: "'JetBrains Mono', monospace" }}>
          {count} item{count !== 1 ? 's' : ''}
          {devSignalsAge != null && ` · signals ${devSignalsAge}m ago`}
        </span>
        <span style={{
          color: '#444', fontSize: 10,
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.2s',
        }}>▾</span>
      </div>

      {/* Feed body */}
      {expanded && (
        <div style={{
          maxHeight: 400,
          overflowY: 'auto',
          overflowX: 'hidden',
          scrollbarWidth: 'thin',
          scrollbarColor: '#252525 #080808',
        }}>
          {count === 0 && !loading && (
            <div style={{ padding: '20px 16px', textAlign: 'center', color: '#333', fontSize: 11, fontStyle: 'italic' }}>
              No alerts today. Portfolio is quiet.
            </div>
          )}
          {loading && count === 0 && (
            <div style={{ padding: '14px 16px', textAlign: 'center', color: '#444', fontSize: 10 }}>
              Scanning...
            </div>
          )}
          {rows.map((row, ri) => {
            if (row.type === 'group') {
              const items = row.items;
              const sample = items[0];
              const c = HL[sample.urgency] || HL.LOW;
              const label = GROUP_LABELS[row.category] || row.category;
              const isOpen = expandedGroups.has(row.category);
              const newInGroup = items.filter(h => !clickedTickers.has(h.ticker)).length;
              const isSS = row.category === 'TRIGGERED_SS' || row.category === 'DEV_SS';
              const isBL = row.category === 'TRIGGERED_BL' || row.category === 'DEV_BL';
              const tickerColor = isSS ? '#ef5350' : isBL ? '#4caf50' : c.ticker;
              return (
                <div key={row.category}>
                  {/* Group header row */}
                  <div
                    onClick={() => setExpandedGroups(prev => {
                      const next = new Set(prev);
                      next.has(row.category) ? next.delete(row.category) : next.add(row.category);
                      return next;
                    })}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: '5px 10px 5px 0',
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      background: isSS ? '#1a0000' : c.bg,
                      borderLeft: `2px solid ${isSS ? '#d32f2f' : c.border}`,
                      fontSize: 11,
                      minHeight: 28,
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    <span style={{
                      color: '#3a3a3a',
                      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                      fontSize: 9,
                      minWidth: 38,
                      textAlign: 'right',
                      flexShrink: 0,
                      paddingLeft: 8,
                    }}>
                      {fmtTime(sample.time)}
                    </span>
                    <span style={{ fontSize: 11, flexShrink: 0, lineHeight: 1, width: 16, textAlign: 'center' }}>{sample.icon}</span>
                    <span style={{
                      background: isSS ? '#b71c1c' : c.badge,
                      color: isSS ? '#fff' : c.badgeText,
                      padding: '1px 5px',
                      borderRadius: 2,
                      fontSize: 8,
                      fontWeight: 800,
                      letterSpacing: '0.04em',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      lineHeight: '14px',
                      minWidth: 52,
                      textAlign: 'center',
                    }}>
                      {sample.urgency}
                    </span>
                    <span style={{
                      color: isSS ? '#ffcdd2' : c.text,
                      fontWeight: 700,
                      fontSize: 10,
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}>
                      {items.length} {label}
                      {newInGroup > 0 && (
                        <span className="feed-chip-new" style={{
                          background: '#FCF000',
                          color: '#000',
                          padding: '0 5px',
                          borderRadius: 3,
                          fontSize: 8,
                          fontWeight: 900,
                          letterSpacing: '0.05em',
                        }}>
                          {newInGroup} NEW
                        </span>
                      )}
                    </span>
                    <span style={{
                      color: '#555',
                      fontSize: 9,
                      transform: isOpen ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.15s',
                      flexShrink: 0,
                    }}>▾</span>
                    {/* Dismiss entire group */}
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        setDismissedIds(prev => {
                          const next = new Set(prev);
                          for (const h of items) next.add(h.id);
                          return next;
                        });
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#ff5252'; e.currentTarget.style.opacity = 1; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = '#555'; e.currentTarget.style.opacity = 0.6; }}
                      style={{
                        color: '#555',
                        opacity: 0.6,
                        fontSize: 12,
                        cursor: 'pointer',
                        flexShrink: 0,
                        padding: '0 4px',
                        lineHeight: 1,
                      }}
                    >
                      ✕
                    </span>
                  </div>

                  {/* Expanded: scrollable ticker strip with individual items */}
                  {isOpen && (
                    <div style={{
                      background: isSS ? 'rgba(30,0,0,0.4)' : 'rgba(0,0,0,0.25)',
                      borderLeft: `2px solid ${isSS ? '#d32f2f' : c.border}`,
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      padding: '6px 10px',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 4,
                      maxHeight: 180,
                      overflowY: 'auto',
                      scrollbarWidth: 'thin',
                      scrollbarColor: '#252525 transparent',
                    }}>
                      {items.map((h, hi) => {
                        const sector = h.sector || null;
                        const emaUp = h.sectorAboveEma;
                        const isNew = !clickedTickers.has(h.ticker);
                        const aPct = h._analyzePct || 0;
                        return (
                          <span
                            key={h.id + hi}
                            onClick={(e) => {
                              e.stopPropagation();
                              setClickedTickers(prev => new Set(prev).add(h.ticker));
                              onTickerClick?.(h.ticker, items.map(x => x.ticker));
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = c.border; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = isNew ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)'; }}
                            title={`Analyze: ${aPct}%${sector ? ` · ${sector} ${emaUp === true ? '▲ above' : emaUp === false ? '▼ below' : ''} 21W EMA` : ''}`}
                            className={isNew ? 'feed-chip-new' : undefined}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              background: isNew ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
                              border: `1px solid ${isNew ? '#FCF000' : isSS ? 'rgba(239,83,80,0.5)' : c.border}`,
                              borderRadius: 3,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              transition: 'background 0.15s',
                            }}
                          >
                            <span style={{
                              color: tickerColor,
                              fontWeight: 800,
                              fontSize: 10,
                            }}>
                              {h.ticker}
                            </span>
                            {aPct > 0 && (
                              <span style={{
                                color: '#fff',
                                background: aPct >= 80 ? '#2e7d32' : aPct >= 50 ? '#7b6b00' : '#333',
                                padding: '0 4px',
                                borderRadius: 2,
                                fontSize: 8,
                                fontWeight: 700,
                                fontFamily: "'JetBrains Mono', monospace",
                                lineHeight: '14px',
                              }}>
                                {aPct}%
                              </span>
                            )}
                            {sector && (
                              <span style={{
                                color: 'rgba(255,255,255,0.7)',
                                fontSize: 8,
                                fontWeight: 500,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 2,
                              }}>
                                {sector}
                                {emaUp === true && <span style={{ color: '#4caf50', fontSize: 8, fontWeight: 800 }}>▲</span>}
                                {emaUp === false && <span style={{ color: '#ef5350', fontSize: 8, fontWeight: 800 }}>▼</span>}
                              </span>
                            )}
                            {/* Dismiss individual item from group */}
                            <span
                              onClick={(ev) => { ev.stopPropagation(); setDismissedIds(prev => new Set(prev).add(h.id)); }}
                              onMouseEnter={(ev) => { ev.currentTarget.style.color = '#ff5252'; }}
                              onMouseLeave={(ev) => { ev.currentTarget.style.color = '#555'; }}
                              style={{
                                color: '#555',
                                fontSize: 9,
                                cursor: 'pointer',
                                marginLeft: 2,
                                lineHeight: 1,
                              }}
                            >
                              ✕
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            // Single (ungrouped) row
            const h = row.item;
            const c = HL[h.urgency] || HL.LOW;
            return (
              <div
                key={h.id + ri}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '4px 10px 4px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                  background: c.bg,
                  borderLeft: `2px solid ${c.border}`,
                  fontSize: 11,
                  lineHeight: 1.45,
                  minHeight: 26,
                }}
              >
                {/* Timestamp */}
                <span style={{
                  color: '#3a3a3a',
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  fontSize: 9,
                  minWidth: 38,
                  textAlign: 'right',
                  flexShrink: 0,
                  paddingLeft: 8,
                }}>
                  {fmtTime(h.time)}
                </span>

                {/* Icon */}
                <span style={{ fontSize: 11, flexShrink: 0, lineHeight: 1, width: 16, textAlign: 'center' }}>{h.icon}</span>

                {/* Urgency badge */}
                <span style={{
                  background: c.badge,
                  color: c.badgeText,
                  padding: '1px 5px',
                  borderRadius: 2,
                  fontSize: 8,
                  fontWeight: 800,
                  letterSpacing: '0.04em',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  lineHeight: '14px',
                  minWidth: 52,
                  textAlign: 'center',
                }}>
                  {h.urgency}
                </span>

                {/* Ticker — clickable to open chart */}
                {h.ticker && (
                  <span
                    onClick={(e) => { e.stopPropagation(); onTickerClick?.(h.ticker); }}
                    onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; e.currentTarget.style.textDecorationColor = c.ticker; }}
                    onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                    style={{
                      color: c.ticker,
                      fontWeight: 800,
                      fontSize: 10,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      minWidth: 36,
                      cursor: 'pointer',
                      textDecoration: 'none',
                      textUnderlineOffset: 2,
                    }}
                  >
                    {h.ticker}
                  </span>
                )}

                {/* Message */}
                <span style={{
                  color: c.text,
                  flex: 1,
                  minWidth: 0,
                  fontSize: 10,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {h.message}
                </span>

                {/* Dismiss */}
                <span
                  onClick={(e) => { e.stopPropagation(); setDismissedIds(prev => new Set(prev).add(h.id)); }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#ff5252'; e.currentTarget.style.opacity = 1; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = '#555'; e.currentTarget.style.opacity = 0.6; }}
                  style={{
                    color: '#555',
                    opacity: 0.6,
                    fontSize: 12,
                    cursor: 'pointer',
                    flexShrink: 0,
                    padding: '0 4px',
                    lineHeight: 1,
                  }}
                >
                  ✕
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Bottom accent */}
      {expanded && count > 0 && (
        <div style={{
          height: 1,
          background: 'linear-gradient(90deg, transparent 10%, #FCF000 50%, transparent 90%)',
          opacity: 0.08,
        }} />
      )}

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes feed-chip-flash {
          0%, 100% { border-color: #FCF000; box-shadow: 0 0 4px rgba(252,240,0,0.4); }
          50% { border-color: rgba(252,240,0,0.2); box-shadow: none; }
        }
        .feed-chip-new {
          animation: feed-chip-flash 1.5s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function AssistantPage({ onNavigate }) {
  const [tasks,          setTasks]          = useState([]);
  const [stopSyncRows,   setStopSyncRows]   = useState([]);
  const [stopSyncLabel,  setStopSyncLabel]  = useState('STOP CHECK');
  const [routines,       setRoutines]       = useState([]);
  const [routineDayLbl,  setRoutineDayLbl]  = useState('');
  const [completed,      setCompleted]      = useState([]);
  const [completedIds,   setCompletedIds]   = useState(new Set());
  const [routineIds,     setRoutineIds]     = useState(new Set());
  const [syncDoneMap,    setSyncDoneMap]    = useState({});
  const [syncExpanded,   setSyncExpanded]   = useState(true);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);
  const [refreshCountdown, setRefreshCountdown] = useState(REFRESH_INTERVAL);
  const [lastRefreshed,    setLastRefreshed]    = useState(null);
  const [chartStocks, setChartStocks] = useState(null);  // array of stock objects for ChartModal
  const [chartIndex,  setChartIndex]  = useState(0);     // initial index into chartStocks
  const [chartBusy,   setChartBusy]   = useState(null);  // ticker currently loading
  const [healthPositions, setHealthPositions] = useState([]);
  const [healthLoading,   setHealthLoading]   = useState(true);
  const [recentFills,     setRecentFills]     = useState([]);
  const [ibkrDiscrepancies,  setIbkrDiscrepancies]  = useState([]);
  const [ibkrDiscLoading,    setIbkrDiscLoading]    = useState(false);
  const [ibkrConnected,      setIbkrConnected]      = useState(false);
  const [ibkrTrades,         setIbkrTrades]         = useState([]);
  const [ibkrTradesLoading,  setIbkrTradesLoading]  = useState(false);
  const [headlines,          setHeadlines]          = useState([]);
  const [headlinesLoading,   setHeadlinesLoading]   = useState(true);
  const [devSignalsAge,      setDevSignalsAge]      = useState(null);

  // Analyze context for scoring chips
  const analyzeCtx = useAnalyzeContext();

  // ── Filter chip sections to analyze >= 90% ────────────────────────────────
  // Runs whenever routines or analyze context updates. For each routine that has
  // chipSections, scores every candidate chip and keeps only those with pct >= 90.
  // Shows up to 5 per section. ETF chips use the same function (max 53 pts).
  const filteredRoutines = useMemo(() => {
    // If analyze context isn't loaded yet, show chips unfiltered so the user
    // isn't left staring at empty sections while context loads.
    if (!analyzeCtx || !routines.length) return routines;

    return routines.map(routine => {
      if (!routine.chipSections?.length) return routine;

      const filteredSections = routine.chipSections.map(section => {
        if (!section.chips?.length) return section;

        // Score every candidate chip in this section.
        // Threshold: >= 80% analyze (catches RECENT signals too, not just FRESH).
        // Chips with pct >= 90 are green; 80-89 are yellow — score shown on chip.
        const scored = section.chips
          .map(chip => {
            // Build a minimal stock-like object for computeAnalyzeScore
            const stockObj = {
              ticker:       chip.ticker,
              signal:       chip.direction,  // 'BL' or 'SS'
              signalAge:    chip.signalAge,
              weeksSince:   chip.signalAge,
              totalScore:   chip.score,
              killScore:    chip.score,
              sector:       chip.sector,
              exchange:     chip.exchange,
              currentPrice: chip.price,
            };
            const result = computeAnalyzeScore(stockObj, analyzeCtx);
            return { chip: { ...chip, analyzePct: result?.pct ?? 0 }, pct: result?.pct ?? 0 };
          })
          .filter(({ pct }) => pct >= 80)
          .sort((a, b) => b.pct - a.pct)
          .slice(0, 5);

        // If none pass, show empty section (will be hidden by ChipSection if chips=[])
        return { ...section, chips: scored.map(({ chip }) => chip) };
      }).filter(section => section.chips?.length > 0);

      return { ...routine, chipSections: filteredSections };
    });
  }, [routines, analyzeCtx]);

  // ── Data Fetching ──────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      // Fire health fetch immediately but don't await it here — it's slower (FMP per position).
      // It resolves independently and updates its own loading state.
      setHealthLoading(true);
      fetch(`${API_BASE}/api/assistant/position-health`, { headers: authHeaders() })
        .then(r => r.ok ? r.json() : { positions: [] })
        .then(d => setHealthPositions(d.positions || []))
        .catch(() => setHealthPositions([]))
        .finally(() => setHealthLoading(false));

      // IBKR discrepancy check + trades-today — fire independently alongside health
      setIbkrDiscLoading(true);
      fetchIbkrDiscrepancies()
        .then(d => {
          setIbkrConnected(!!d.ibkrConnected);
          setIbkrDiscrepancies(d.discrepancies || []);
        })
        .catch(() => { setIbkrConnected(false); setIbkrDiscrepancies([]); })
        .finally(() => setIbkrDiscLoading(false));

      setIbkrTradesLoading(true);
      fetchIbkrTradesToday()
        .then(d => setIbkrTrades(d.trades || []))
        .catch(() => setIbkrTrades([]))
        .finally(() => setIbkrTradesLoading(false));

      // Recent fills — fast DB lookup, fire independently
      fetch(`${API_BASE}/api/assistant/overnight-fills`, { headers: authHeaders() })
        .then(r => r.ok ? r.json() : { fills: [] })
        .then(d => setRecentFills(d.fills || []))
        .catch(() => setRecentFills([]));

      const [tasksRes, syncRes, routinesRes, completedRes] = await Promise.all([
        fetch(`${API_BASE}/api/assistant/tasks`,    { headers: authHeaders() }),
        fetch(`${API_BASE}/api/assistant/stop-sync`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/assistant/routines`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/assistant/completed`, { headers: authHeaders() }),
      ]);

      if (tasksRes.ok) {
        const d = await tasksRes.json();
        setTasks(d.tasks || []);
      }

      if (syncRes.ok) {
        const d = await syncRes.json();
        setStopSyncRows(d.rows || []);
        setStopSyncLabel(d.label || 'STOP CHECK');
        const dow = d.dayOfWeek ?? new Date().getDay();
        setRoutineDayLbl(dayLabel(dow).toUpperCase());
      }

      if (routinesRes.ok) {
        const d = await routinesRes.json();
        setRoutines(d.routines || []);
        if (!routineDayLbl) {
          const dow = d.dayOfWeek ?? new Date().getDay();
          setRoutineDayLbl(dayLabel(dow).toUpperCase());
        }
      }

      if (completedRes.ok) {
        const d = await completedRes.json();
        const items = d.completed || [];
        setCompleted(items);
        const ids = new Set(items.map(c => c.taskId));
        setCompletedIds(ids);
        // Partition routine IDs
        const rIds = new Set(items.filter(c => !c.taskType || c.taskType === 'ROUTINE').map(c => c.taskId));
        setRoutineIds(rIds);
      }

      setLastRefreshed(new Date());
    } catch (err) {
      setError('Failed to load assistant data. Please refresh.');
      console.error('[AssistantPage] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial load
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Auto-refresh countdown
  useEffect(() => {
    const iv = setInterval(() => {
      setRefreshCountdown(c => {
        if (c <= 1) {
          fetchAll();
          return REFRESH_INTERVAL;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  // ── Headlines feed — polls every 60s ───────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    const loadHeadlines = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/assistant/headlines`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        if (mounted) {
          setHeadlines(data.headlines || []);
          setDevSignalsAge(data.devSignalsAge ?? null);
          setHeadlinesLoading(false);
        }
      } catch { if (mounted) setHeadlinesLoading(false); }
    };
    loadHeadlines();
    const iv = setInterval(loadHeadlines, 60000);
    return () => { mounted = false; clearInterval(iv); };
  }, []);

  // ── Mark Task Done ─────────────────────────────────────────────────────────

  async function handleMarkDone(task) {
    try {
      await fetch(`${API_BASE}/api/assistant/complete`, {
        method:  'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ taskId: task.id, taskType: task.type, ticker: task.ticker }),
      });
      setCompletedIds(prev => new Set([...prev, task.id]));
      setCompleted(prev => [{
        taskId:      task.id,
        taskType:    task.type,
        ticker:      task.ticker,
        completedAt: new Date().toISOString(),
      }, ...prev]);
    } catch (err) {
      console.error('[AssistantPage] mark done error:', err);
    }
  }

  // ── Toggle Routine Item ────────────────────────────────────────────────────

  async function handleToggleRoutine(routineId) {
    const isDone = routineIds.has(routineId);
    if (isDone) {
      // Un-completing locally (no server delete — just optimistic)
      setRoutineIds(prev => {
        const next = new Set(prev);
        next.delete(routineId);
        return next;
      });
      setCompletedIds(prev => {
        const next = new Set(prev);
        next.delete(routineId);
        return next;
      });
    } else {
      try {
        await fetch(`${API_BASE}/api/assistant/complete`, {
          method:  'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body:    JSON.stringify({ taskId: routineId, taskType: 'ROUTINE', ticker: null }),
        });
        setRoutineIds(prev => new Set([...prev, routineId]));
        setCompletedIds(prev => new Set([...prev, routineId]));
      } catch (err) {
        console.error('[AssistantPage] routine toggle error:', err);
      }
    }
  }

  // ── Toggle Stop Sync Row ───────────────────────────────────────────────────

  async function handleToggleStopSync(ticker) {
    const isDone = !!syncDoneMap[ticker];
    setSyncDoneMap(prev => ({ ...prev, [ticker]: !isDone }));
    if (!isDone) {
      try {
        await fetch(`${API_BASE}/api/assistant/complete`, {
          method:  'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body:    JSON.stringify({ taskId: `stop_sync_${ticker}`, taskType: 'STOP_SYNC', ticker }),
        });
      } catch { /* best effort */ }
    }
  }

  async function handleMarkAllSynced() {
    const map = {};
    for (const r of stopSyncRows) {
      map[r.ticker] = true;
      try {
        await fetch(`${API_BASE}/api/assistant/complete`, {
          method:  'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body:    JSON.stringify({ taskId: `stop_sync_${r.ticker}`, taskType: 'STOP_SYNC', ticker: r.ticker }),
        });
      } catch { /* best effort */ }
    }
    setSyncDoneMap(map);
  }

  // ── Open Chart from Chip Click ─────────────────────────────────────────────

  async function fetchStockData(ticker) {
    const [apexRes, tickerRes] = await Promise.all([
      fetch(`${API_BASE}/api/apex/ticker/${encodeURIComponent(ticker)}`, { headers: authHeaders() }).catch(() => null),
      fetch(`${API_BASE}/api/ticker/${encodeURIComponent(ticker)}`, { headers: authHeaders() }).catch(() => null),
    ]);
    if (apexRes?.ok) {
      const data = await apexRes.json();
      if (data.found && data.stock) return data.stock;
    }
    if (tickerRes?.ok) {
      const data2 = await tickerRes.json();
      if (data2) return { ticker, ...data2 };
    }
    return { ticker };
  }

  async function handleChipClick(chip) {
    if (chartBusy) return;
    const ticker = chip.ticker;
    setChartBusy(ticker);
    try {
      if (chip.groupTickers?.length > 1) {
        // Build array with clicked stock fetched now, others as stubs (lazy-loaded by ChartModal)
        const clickedStock = await fetchStockData(ticker);
        const idx = chip.groupTickers.indexOf(ticker);
        const stocks = chip.groupTickers.map((t, i) =>
          i === idx ? (clickedStock || { ticker: t }) : { ticker: t, _stub: true }
        );
        setChartStocks(stocks);
        setChartIndex(Math.max(0, idx));
      } else {
        const stock = await fetchStockData(ticker);
        if (stock) { setChartStocks([stock]); setChartIndex(0); }
      }
    } catch (e) {
      console.error('[AssistantPage] chart fetch error:', e);
    } finally {
      setChartBusy(null);
    }
  }

  // ── Partition Tasks ────────────────────────────────────────────────────────

  const p1Tasks = tasks.filter(t => t.priority === 1);
  const p2Tasks = tasks.filter(t => t.priority === 2);
  const p3Tasks = tasks.filter(t => t.priority === 3);

  const p1Count = p1Tasks.filter(t => !completedIds.has(t.id)).length;
  const p2Count = p2Tasks.filter(t => !completedIds.has(t.id)).length;
  const p3Count = p3Tasks.filter(t => !completedIds.has(t.id)).length;
  const routineDoneCount = routines.filter(r => routineIds.has(r.id)).length;

  const syncNeedsCount = stopSyncRows.filter(r => r.needsUpdate && !syncDoneMap[r.ticker]).length;

  if (loading) {
    return (
      <div style={s.page}>
        <div style={s.spinner}>Loading PNTHR Assistant...</div>
      </div>
    );
  }

  return (
    <div style={s.page}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={s.header}>
        <div>
          <h1 style={s.headerTitle}>PNTHR ASSISTANT</h1>
          <div style={s.headerMeta}>{nowEtString()}</div>
          <div style={s.countBar}>
            {p1Count > 0 && <span style={s.countPill(PRIORITY_COLOR[1])}>{p1Count} critical</span>}
            {p2Count > 0 && <span style={s.countPill(PRIORITY_COLOR[2])}>{p2Count} action</span>}
            {p3Count > 0 && <span style={s.countPill(PRIORITY_COLOR[3])}>{p3Count} review</span>}
            {routines.length > 0 && (
              <span style={s.countPill(PRIORITY_COLOR[4])}>
                {routines.length - routineDoneCount} routine
              </span>
            )}
          </div>
        </div>
        <div style={s.headerRight}>
          <button
            style={s.refreshBtn}
            onClick={() => { setLoading(true); fetchAll(); setRefreshCountdown(REFRESH_INTERVAL); }}
          >
            ↺ Refresh
          </button>
          <div style={s.refreshTimer}>refreshing in {refreshCountdown}s</div>
          {lastRefreshed && (
            <div style={s.refreshTimer}>
              last: {lastRefreshed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}
            </div>
          )}
        </div>
      </div>

      {error && <div style={s.error}>{error}</div>}

      {/* ══════════════════════════════════════════════════════════════════════
           SECTION 1 — LIVE OPPORTUNITIES
         ══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        border: '1px solid rgba(252, 240, 0, 0.3)',
        borderRadius: 8,
        padding: '0 0 4px',
        marginBottom: 16,
        background: 'rgba(252, 240, 0, 0.01)',
      }}>
        <div style={{
          padding: '7px 14px 5px',
          borderBottom: '1px solid rgba(252, 240, 0, 0.12)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{
            color: '#FCF000',
            fontWeight: 900,
            fontSize: 10,
            letterSpacing: '0.14em',
            fontFamily: "'Inter', 'Segoe UI', sans-serif",
          }}>LIVE OPPORTUNITIES</span>
          <span style={{
            flex: 1,
            height: 1,
            background: 'linear-gradient(90deg, rgba(252,240,0,0.15), transparent 80%)',
          }} />
        </div>

        <div style={{ padding: '8px 10px 4px' }}>
          {/* Live Headline Feed */}
          <HeadlineFeed
            headlines={headlines}
            loading={headlinesLoading}
            devSignalsAge={devSignalsAge}
            onTickerClick={(ticker, groupTickers) => handleChipClick({ ticker, groupTickers })}
            analyzeCtx={analyzeCtx}
          />

          {/* P1: Critical */}
          {p1Tasks.length > 0 && (
            <>
              <div style={s.sectionHeader}>
                <span style={{ ...s.sectionLabel, color: PRIORITY_COLOR[1] }}>
                  ● {PRIORITY_LABEL[1]} ({p1Count} open)
                </span>
              </div>
              {p1Tasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isCompleted={completedIds.has(task.id)}
                  onMarkDone={handleMarkDone}
                />
              ))}
            </>
          )}

          {/* P2: Action */}
          {p2Tasks.length > 0 && (
            <>
              <div style={s.sectionHeader}>
                <span style={{ ...s.sectionLabel, color: PRIORITY_COLOR[2] }}>
                  ● {PRIORITY_LABEL[2]} ({p2Count} open)
                </span>
              </div>
              {p2Tasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isCompleted={completedIds.has(task.id)}
                  onMarkDone={handleMarkDone}
                />
              ))}
            </>
          )}

          {/* P3: Review */}
          {p3Tasks.length > 0 && (
            <>
              <div style={s.sectionHeader}>
                <span style={{ ...s.sectionLabel, color: PRIORITY_COLOR[3] }}>
                  ● {PRIORITY_LABEL[3]} ({p3Count} open)
                </span>
              </div>
              {p3Tasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isCompleted={completedIds.has(task.id)}
                  onMarkDone={handleMarkDone}
                />
              ))}
            </>
          )}

          {/* Nothing to show */}
          {!loading && tasks.length === 0 && headlines.length === 0 && (
            <div style={s.empty}>
              No tasks today — portfolio is quiet. Check back after market open.
            </div>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
           SECTION 2 — LIVE WATCH
         ══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        border: '1px solid rgba(252, 240, 0, 0.3)',
        borderRadius: 8,
        padding: '0 0 4px',
        marginBottom: 16,
        background: 'rgba(252, 240, 0, 0.01)',
      }}>
        <div style={{
          padding: '7px 14px 5px',
          borderBottom: '1px solid rgba(252, 240, 0, 0.12)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{
            color: '#FCF000',
            fontWeight: 900,
            fontSize: 10,
            letterSpacing: '0.14em',
            fontFamily: "'Inter', 'Segoe UI', sans-serif",
          }}>LIVE WATCH</span>
          <span style={{
            flex: 1,
            height: 1,
            background: 'linear-gradient(90deg, rgba(252,240,0,0.15), transparent 80%)',
          }} />
        </div>

        <div style={{ padding: '8px 10px 4px' }}>
          {/* IBKR Discrepancy Check */}
          <IbkrDiscrepancySection
            discrepancies={ibkrDiscrepancies}
            loading={ibkrDiscLoading}
            ibkrConnected={ibkrConnected}
          />

          {/* Command Health */}
          <CommandHealthSection positions={healthPositions} loading={healthLoading} />

          {/* Stop Sync */}
          {stopSyncRows.length > 0 && (
            <div style={s.syncSection}>
              <div style={s.syncHeader} onClick={() => setSyncExpanded(e => !e)}>
                <div style={s.syncHeaderLeft}>
                  <span style={{ fontSize: 11, color: '#444' }}>{syncExpanded ? '▼' : '▶'}</span>
                  <span style={s.syncLabel}>{stopSyncLabel}</span>
                  <span style={s.syncCount}>
                    ({stopSyncRows.length} position{stopSyncRows.length !== 1 ? 's' : ''}
                    {syncNeedsCount > 0 ? ` — ${syncNeedsCount} need updating` : ' — all synced'})
                  </span>
                </div>
              </div>
              {syncExpanded && (
                <>
                  {syncNeedsCount === 0 ? (
                    <div style={{ padding: '14px 16px', fontSize: 12, color: '#28a745' }}>
                      ✓ All {stopSyncRows.length} stops are up to date — nothing to sync today.
                    </div>
                  ) : (
                    <>
                      {stopSyncRows.filter(r => r.needsUpdate && !syncDoneMap[r.ticker]).map(row => (
                        <StopSyncRow
                          key={row.ticker}
                          row={row}
                          isDone={false}
                          onToggle={handleToggleStopSync}
                        />
                      ))}
                      <div style={s.syncFooter}>
                        <button style={s.syncAllBtn} onClick={handleMarkAllSynced}>
                          MARK ALL STOPS UPDATED ✓
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Routines */}
          {filteredRoutines.length > 0 && (
            <>
              <div style={s.sectionHeader}>
                <span style={{ ...s.sectionLabel, color: PRIORITY_COLOR[4] }}>
                  ● {PRIORITY_LABEL[4]}
                </span>
              </div>
              <RoutineSection
                routines={filteredRoutines}
                dayLabel={routineDayLbl}
                completedIds={routineIds}
                onToggle={handleToggleRoutine}
                onChipClick={handleChipClick}
                busyTicker={chartBusy}
              />
            </>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
           SECTION 3 — TODAY'S ACCOMPLISHMENTS
         ══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        border: '1px solid rgba(252, 240, 0, 0.3)',
        borderRadius: 8,
        padding: '0 0 4px',
        marginBottom: 16,
        background: 'rgba(252, 240, 0, 0.01)',
      }}>
        <div style={{
          padding: '7px 14px 5px',
          borderBottom: '1px solid rgba(252, 240, 0, 0.12)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{
            color: '#FCF000',
            fontWeight: 900,
            fontSize: 10,
            letterSpacing: '0.14em',
            fontFamily: "'Inter', 'Segoe UI', sans-serif",
          }}>TODAY'S ACCOMPLISHMENTS</span>
          <span style={{
            flex: 1,
            height: 1,
            background: 'linear-gradient(90deg, rgba(252,240,0,0.15), transparent 80%)',
          }} />
        </div>

        <div style={{ padding: '8px 10px 4px' }}>
          {/* Today's IBKR Trades */}
          <TradesTodaySection
            trades={ibkrTrades}
            loading={ibkrTradesLoading}
            ibkrConnected={ibkrConnected}
            onNavigate={onNavigate}
          />

          {/* Recent Fills */}
          <RecentFillsSection fills={recentFills} onNavigate={onNavigate} />

          {/* Completed Today */}
          <CompletedSection completed={completed} />
        </div>
      </div>

      {/* Chart Modal — opened from chip clicks */}
      {chartStocks && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={{}}
          earnings={{}}
          onClose={() => setChartStocks(null)}
        />
      )}

    </div>
  );
}
