// client/src/components/JournalPage.jsx
// ── PNTHR Journal — Trade analysis, discipline tracking, pattern recognition ──

import React, { useState, useEffect } from 'react';
import { API_BASE, authHeaders } from '../services/api';

const DISC_COLORS = (score) => {
  if (score == null) return '#555';
  if (score >= 80) return '#6bcb77';
  if (score >= 60) return '#ffc107';
  return '#ff6b6b';
};

const REASON_COLORS = {
  SIGNAL: '#6bcb77',
  FEAST: '#FFD700',
  STOP_HIT: '#ff8c00',
  STALE_HUNT: '#ff8c00',
  MANUAL: '#dc3545',
};

const SUGGESTED_TAGS = ['kill-top-10', 'earnings-play', 'sector-rotation', 'breakout', 'mean-reversion', 'scalp'];

export default function JournalPage({ onNavigate }) {
  const [tab, setTab] = useState('trades');
  const [entries, setEntries] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [weeklyReviews, setWeeklyReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState(-1);
  const [expandedId, setExpandedId] = useState(null);
  const [noteInputs, setNoteInputs] = useState({});
  const [weeklyReflection, setWeeklyReflection] = useState('');
  const [savingReview, setSavingReview] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [entriesRes, analyticsRes, reviewsRes] = await Promise.all([
        fetch(`${API_BASE}/api/journal`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/journal/analytics`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/journal/weekly-reviews`, { headers: authHeaders() }),
      ]);
      if (entriesRes.ok) setEntries(await entriesRes.json());
      if (analyticsRes.ok) setAnalytics(await analyticsRes.json());
      if (reviewsRes.ok) setWeeklyReviews(await reviewsRes.json());
    } catch (e) { console.error('[JOURNAL]', e); }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

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
    color: sortField === field ? '#FFD700' : '#666',
    fontSize: 10, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', padding: '6px 8px',
    textAlign: 'left', borderBottom: '1px solid #222', whiteSpace: 'nowrap',
  });
  const tdStyle = { padding: '7px 8px', fontSize: 12, color: '#ccc', borderBottom: '1px solid #1a1a1a', verticalAlign: 'middle' };

  const DisciplineStrip = () => (
    <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
      {[
        { label: 'OVERALL SCORE', value: analytics?.avgDisciplineScore != null ? `${analytics.avgDisciplineScore}/100` : '—', color: DISC_COLORS(analytics?.avgDisciplineScore) },
        { label: 'CLEAN STREAK', value: analytics?.streak != null ? `${analytics.streak} trades` : '—', color: '#6bcb77' },
        { label: 'OVERRIDES / MO', value: analytics?.overridesThisMonth != null ? String(analytics.overridesThisMonth) : '—', color: analytics?.overridesThisMonth > 0 ? '#ff8c00' : '#6bcb77' },
        { label: 'WIN RATE (DISC)', value: analytics?.disciplineWinRate != null ? `${analytics.disciplineWinRate}%` : '—', color: '#6bcb77' },
        { label: 'WIN RATE (OVRD)', value: analytics?.overrideWinRate != null ? `${analytics.overrideWinRate}%` : '—', color: '#ff8c00' },
      ].map(card => (
        <div key={card.label} style={{ background: '#111', borderRadius: 10, padding: '12px 18px', flex: '1 1 140px', minWidth: 120 }}>
          <div style={{ color: '#555', fontSize: 9, letterSpacing: 2, fontWeight: 700, marginBottom: 4 }}>{card.label}</div>
          <div style={{ color: card.color, fontSize: 22, fontWeight: 900 }}>{card.value}</div>
        </div>
      ))}
    </div>
  );

  const TradeDetail = ({ entry }) => {
    const pnl = entry.performance?.totalPnlDollar ?? entry.performance?.realizedPnlDollar ?? null;
    const disc = entry.discipline;
    return (
      <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: 8, padding: 16, marginTop: 2 }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1 }}>ENTRY</div>
            <div style={{ fontSize: 12, color: '#ccc' }}>
              Filled: {entry.entry?.fillDate || '—'} @ ${entry.entry?.fillPrice?.toFixed(2) || '—'}
            </div>
            {entry.entry?.stopPrice && <div style={{ fontSize: 11, color: '#888' }}>Stop: ${entry.entry.stopPrice.toFixed(2)}</div>}
            {entry.entry?.killRank && <div style={{ fontSize: 11, color: '#FFD700' }}>Kill #{entry.entry.killRank} — {entry.entry.killTier}</div>}
          </div>
          <div>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1 }}>LOTS FILLED</div>
            {(entry.lots || []).map(lot => (
              <div key={lot.lot} style={{ fontSize: 11, color: '#ccc' }}>
                #{lot.lot} {lot.shares} shr @ ${lot.price?.toFixed(2)} · {lot.date}
              </div>
            ))}
          </div>
        </div>

        {(entry.exits || []).length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>EXITS</div>
            {(entry.exits || []).map(ex => (
              <div key={ex.id} style={{ display: 'flex', gap: 10, fontSize: 11, color: '#ccc', padding: '2px 0', alignItems: 'center' }}>
                <span style={{ color: '#555', minWidth: 24 }}>{ex.id}</span>
                <span>{ex.shares} shr @ ${ex.price?.toFixed(2)}</span>
                <span style={{ color: '#555' }}>·</span>
                <span>{ex.date}</span>
                <span style={{ color: REASON_COLORS[ex.reason] || '#888', fontWeight: 700 }}>{ex.reason}{ex.isOverride ? ' ⚠' : ''}</span>
                <span style={{ color: ex.pnl?.dollar >= 0 ? '#6bcb77' : '#ff6b6b', marginLeft: 'auto' }}>
                  {ex.pnl?.dollar >= 0 ? '+' : ''}{ex.pnl?.dollar?.toFixed(2)} ({ex.pnl?.pct >= 0 ? '+' : ''}{ex.pnl?.pct?.toFixed(1)}%)
                </span>
                {ex.note && <span style={{ color: '#555', fontSize: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ex.note}>"{ex.note}"</span>}
              </div>
            ))}
          </div>
        )}

        {disc?.totalScore != null && (
          <div style={{ background: '#111', borderRadius: 6, padding: '10px 14px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ color: '#555', fontSize: 10, letterSpacing: 1 }}>DISCIPLINE SCORE</span>
              <span style={{ color: DISC_COLORS(disc.totalScore), fontSize: 20, fontWeight: 900 }}>{disc.totalScore}/100</span>
            </div>
            <div style={{ display: 'flex', gap: 20, fontSize: 11, flexWrap: 'wrap' }}>
              <div>Entry: <span style={{ color: '#fff', fontWeight: 700 }}>{disc.entryScore}/30</span></div>
              <div>Hold: <span style={{ color: '#fff', fontWeight: 700 }}>{disc.holdScore}/30</span></div>
              <div>Exit: <span style={{ color: '#fff', fontWeight: 700 }}>{disc.exitScore}/40</span></div>
              {disc.overrideCount > 0 && <div style={{ color: '#dc3545' }}>⚠ {disc.overrideCount} override{disc.overrideCount > 1 ? 's' : ''}</div>}
            </div>
          </div>
        )}
        {disc?.totalScore == null && entry.performance?.status !== 'CLOSED' && (
          <div style={{ color: '#555', fontSize: 11, marginBottom: 12 }}>Discipline score: Pending (calculated on close)</div>
        )}

        {entry.whatIf?.signalExitDate && (entry.discipline?.overrideCount || 0) > 0 && (
          <div style={{ background: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.2)', borderRadius: 6, padding: '10px 14px', marginBottom: 12 }}>
            <div style={{ color: '#dc3545', fontSize: 10, letterSpacing: 1, fontWeight: 700, marginBottom: 4 }}>WHAT IF — GHOST COMPARISON</div>
            <div style={{ fontSize: 11, color: '#ccc' }}>
              If you had held to the SIGNAL exit ({entry.whatIf.signalExitDate} @ ${entry.whatIf.signalExitPrice?.toFixed(2)}):
              would have been {entry.whatIf.signalExitPnl >= 0 ? '+' : ''}{entry.whatIf.signalExitPnl?.toFixed(1)}%
            </div>
            {entry.whatIf.overrideCostDollar != null && (
              <div style={{ fontSize: 11, color: '#ff8c00', marginTop: 4 }}>
                Cost of override: {entry.whatIf.overrideCostDollar >= 0 ? '+' : ''}${entry.whatIf.overrideCostDollar?.toFixed(2)} left on table
              </div>
            )}
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 6 }}>NOTES</div>
          {(entry.notes || []).length === 0 && <div style={{ color: '#444', fontSize: 11 }}>No notes yet.</div>}
          {(entry.notes || []).map(note => (
            <div key={note.id} style={{ padding: '6px 0', borderBottom: '1px solid #1a1a1a' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                <span style={{ color: '#555', fontSize: 10 }}>{note.timestamp ? new Date(note.timestamp).toLocaleString() : ''}</span>
                <span style={{ background: '#1a1a1a', color: note.type === 'OVERRIDE' ? '#dc3545' : '#888', fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>{note.type}</span>
                <button onClick={() => deleteNote(entry._id, note.id)}
                  style={{ background: 'none', border: 'none', color: '#333', cursor: 'pointer', fontSize: 11, marginLeft: 'auto' }}>✕</button>
              </div>
              <div style={{ color: '#ccc', fontSize: 12 }}>{note.text}</div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              value={noteInputs[entry._id] || ''}
              onChange={e => setNoteInputs(p => ({ ...p, [entry._id]: e.target.value }))}
              placeholder="Add a note..."
              style={{ flex: 1, background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: 4, padding: '5px 8px', fontSize: 12 }}
            />
            <button onClick={() => addNote(entry._id, 'MID_TRADE')}
              style={{ background: '#FFD700', color: '#000', border: 'none', borderRadius: 4, padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              ADD
            </button>
          </div>
        </div>

        <div>
          <div style={{ color: '#555', fontSize: 10, letterSpacing: 1, marginBottom: 6 }}>TAGS</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {(entry.tags || []).map(tag => (
              <span key={tag} style={{ background: '#1a1a1a', border: '1px solid #333', color: '#aaa', fontSize: 10, padding: '2px 8px', borderRadius: 4, display: 'flex', gap: 4, alignItems: 'center' }}>
                {tag}
                <button onClick={() => removeTag(entry._id, tag)}
                  style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', padding: 0, fontSize: 10 }}>✕</button>
              </span>
            ))}
            {SUGGESTED_TAGS.filter(t => !(entry.tags || []).includes(t)).slice(0, 4).map(t => (
              <button key={t} onClick={() => addTag(entry._id, t)}
                style={{ background: 'none', border: '1px dashed #333', color: '#555', fontSize: 9, padding: '2px 6px', borderRadius: 4, cursor: 'pointer' }}>
                + {t}
              </button>
            ))}
          </div>
        </div>
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
          { label: 'Score 80-100', color: '#6bcb77', trades: entries.filter(e => (e.discipline?.totalScore || 0) >= 80 && e.performance?.status === 'CLOSED') },
          { label: 'Score 60-79', color: '#ffc107', trades: entries.filter(e => { const s = e.discipline?.totalScore; return s != null && s >= 60 && s < 80 && e.performance?.status === 'CLOSED'; }) },
          { label: 'Score 0-59', color: '#dc3545', trades: entries.filter(e => { const s = e.discipline?.totalScore; return s != null && s < 60 && e.performance?.status === 'CLOSED'; }) },
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

      <div style={{ background: '#111', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 800, letterSpacing: 1, marginBottom: 10 }}>WASH RULES</div>
        {entries.filter(e => e.washRule?.isLoss && !e.washRule?.expired).length === 0
          ? <div style={{ color: '#555', fontSize: 12 }}>No active wash rules.</div>
          : entries.filter(e => e.washRule?.isLoss && !e.washRule?.expired).map(e => {
              const expiry = e.washRule.expiryDate;
              const daysLeft = expiry ? Math.max(0, Math.ceil((new Date(expiry) - new Date()) / 86400000)) : null;
              return (
                <div key={e._id} style={{ display: 'flex', gap: 16, fontSize: 12, padding: '6px 0', borderBottom: '1px solid #1a1a1a' }}>
                  <span style={{ color: '#FFD700', fontWeight: 800, minWidth: 50 }}>{e.ticker}</span>
                  <span style={{ color: '#dc3545' }}>⚠ {daysLeft}d remaining</span>
                  <span style={{ color: '#555' }}>Expires {expiry}</span>
                </div>
              );
            })
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

  const tabBtn = (id, label) => (
    <button onClick={() => setTab(id)}
      style={{ background: tab === id ? '#FFD700' : 'transparent', color: tab === id ? '#000' : '#666', border: `1px solid ${tab === id ? '#FFD700' : '#333'}`, borderRadius: 6, padding: '5px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}>
      {label}
    </button>
  );

  return (
    <div style={{ padding: '0 16px 32px', maxWidth: 1200, color: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: '#FFD700', fontSize: 18, fontWeight: 900, letterSpacing: 2 }}>PNTHR JOURNAL</div>
          <div style={{ color: '#555', fontSize: 11 }}>Trade analysis · Discipline tracking · Pattern recognition</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {tabBtn('trades', 'TRADES')}
          {tabBtn('analytics', 'ANALYTICS')}
          {tabBtn('weekly', 'WEEKLY REVIEW')}
        </div>
      </div>

      {loading ? (
        <div style={{ color: '#555', textAlign: 'center', padding: 40 }}>Loading journal...</div>
      ) : (
        <>
          <DisciplineStrip />

          {tab === 'trades' && (
            <>
              <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                {['ALL', 'ACTIVE', 'PARTIAL', 'CLOSED', 'OVERRIDES'].map(f => (
                  <button key={f} onClick={() => setFilterStatus(f)}
                    style={{ background: filterStatus === f ? '#333' : 'transparent', color: filterStatus === f ? '#FFD700' : '#555', border: `1px solid ${filterStatus === f ? '#555' : '#222'}`, borderRadius: 4, padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}>
                    {f}
                  </button>
                ))}
                <span style={{ color: '#333', fontSize: 11, alignSelf: 'center', marginLeft: 8 }}>{sorted.length} trade{sorted.length !== 1 ? 's' : ''}</span>
              </div>

              {sorted.length === 0 ? (
                <div style={{ color: '#555', textAlign: 'center', padding: 40, fontSize: 14 }}>
                  No journal entries yet. Journal entries are auto-created when you confirm a position in Command.
                </div>
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
                        const wash = entry.washRule;
                        const washDays = wash?.isLoss && wash?.expiryDate
                          ? Math.max(0, Math.ceil((new Date(wash.expiryDate) - new Date()) / 86400000))
                          : null;
                        return (
                          <React.Fragment key={entry._id}>
                            <tr
                              onClick={() => setExpandedId(isExpanded ? null : entry._id)}
                              style={{ cursor: 'pointer', background: isExpanded ? '#0d0d0d' : 'transparent' }}
                              onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = '#151515'; }}
                              onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                            >
                              <td style={tdStyle}>{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }) : '—'}</td>
                              <td style={{ ...tdStyle, color: '#FFD700', fontWeight: 800 }}>{entry.ticker}</td>
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
                                  ? <span style={{ color: '#FFD700', fontWeight: 700 }}>#{entry.entry.killRank}{entry.entry.isKillTop10 ? ' *' : ''}</span>
                                  : <span style={{ color: '#555' }}>—</span>}
                              </td>
                              <td style={tdStyle}>
                                {washDays != null && washDays > 0
                                  ? <span style={{ color: '#dc3545', fontWeight: 700 }}>{washDays}d</span>
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
                                  <TradeDetail entry={entry} />
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

          {tab === 'analytics' && <AnalyticsTab />}
          {tab === 'weekly' && <WeeklyReviewTab />}
        </>
      )}
    </div>
  );
}
