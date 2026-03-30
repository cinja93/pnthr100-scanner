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

import { useState, useEffect, useCallback } from 'react';
import { API_BASE, authHeaders } from '../services/api';
import ChartModal from './ChartModal';

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
      <div style={{ ...s.card(task.priority, false), opacity: 0.45 }}>
        <div style={s.cardHeader} onClick={() => setExpanded(e => !e)}>
          <span style={s.badge(task.priority)}>{task.badge}</span>
          {task.ticker && <span style={s.ticker}>{task.ticker}</span>}
          <span style={s.headline}>{task.headline}</span>
          <span style={s.doneTag}>✓ DONE</span>
        </div>
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
      <span style={s.syncStops}>
        {fmt$(row.currentStop)}
        {row.needsUpdate && row.newStop != null && (
          <span style={{ color: '#fd7e14' }}> → {fmt$(row.newStop)}</span>
        )}
        {!row.needsUpdate && (
          <span style={{ color: '#444' }}> (unchanged)</span>
        )}
      </span>
      {row.needsUpdate && !isDone ? (
        <span style={s.syncNeedsUpdate}>{arrow} needs update</span>
      ) : (
        <span style={s.syncOk}>✓</span>
      )}
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
          const isBL   = chip.direction === 'BL';
          const isBusy = busyTicker === chip.ticker;
          return (
            <button
              key={chip.ticker}
              onClick={(e) => { e.stopPropagation(); onChipClick(chip); }}
              disabled={isBusy}
              title={`${chip.ticker} — Kill #${chip.rank ?? '?'} · Score ${chip.score} · ${chip.tier} · ${chip.price != null ? '$' + chip.price : ''}`}
              style={{
                background:    isBL ? 'rgba(40,167,69,0.10)' : 'rgba(239,83,80,0.10)',
                border:        `1px solid ${isBL ? 'rgba(40,167,69,0.35)' : 'rgba(239,83,80,0.35)'}`,
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
          {/* Chip sections — rendered outside the checkbox row so clicks don't toggle */}
          {r.chipSections?.length > 0 && !completedIds.has(r.id) && r.chipSections.map((section, si) => (
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

// ── Main Component ────────────────────────────────────────────────────────────

export default function AssistantPage() {
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
  const [chartStock,  setChartStock]  = useState(null);
  const [chartBusy,   setChartBusy]   = useState(null); // ticker currently loading

  // ── Data Fetching ──────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      setError(null);
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

  async function handleChipClick(chip) {
    if (chartBusy) return;
    setChartBusy(chip.ticker);
    try {
      const res = await fetch(
        `${API_BASE}/api/apex/ticker/${encodeURIComponent(chip.ticker)}`,
        { headers: authHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.found && data.stock) {
          setChartStock(data.stock);
        }
      }
    } catch (e) {
      console.error('[AssistantPage] chip chart fetch error:', e);
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

      {/* ── P1: Critical ───────────────────────────────────────────────────── */}
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

      {/* ── P2: Action ─────────────────────────────────────────────────────── */}
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

      {/* ── Stop Sync ──────────────────────────────────────────────────────── */}
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
              {stopSyncRows.map(row => (
                <StopSyncRow
                  key={row.ticker}
                  row={row}
                  isDone={!!syncDoneMap[row.ticker]}
                  onToggle={handleToggleStopSync}
                />
              ))}
              {syncNeedsCount > 0 && (
                <div style={s.syncFooter}>
                  <button style={s.syncAllBtn} onClick={handleMarkAllSynced}>
                    MARK ALL STOPS UPDATED ✓
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── P3: Review ─────────────────────────────────────────────────────── */}
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

      {/* ── Nothing to show ────────────────────────────────────────────────── */}
      {!loading && tasks.length === 0 && (
        <div style={s.empty}>
          No tasks today — portfolio is clean. Check back after market open.
        </div>
      )}

      {/* ── Routines ───────────────────────────────────────────────────────── */}
      {routines.length > 0 && (
        <>
          <div style={s.sectionHeader}>
            <span style={{ ...s.sectionLabel, color: PRIORITY_COLOR[4] }}>
              ● {PRIORITY_LABEL[4]}
            </span>
          </div>
          <RoutineSection
            routines={routines}
            dayLabel={routineDayLbl}
            completedIds={routineIds}
            onToggle={handleToggleRoutine}
            onChipClick={handleChipClick}
            busyTicker={chartBusy}
          />
        </>
      )}

      {/* ── Completed Today ────────────────────────────────────────────────── */}
      <CompletedSection completed={completed} />

      {/* Chart Modal — opened from chip clicks */}
      {chartStock && (
        <ChartModal
          stocks={[chartStock]}
          initialIndex={0}
          signals={{}}
          earnings={{}}
          onClose={() => setChartStock(null)}
        />
      )}

    </div>
  );
}
