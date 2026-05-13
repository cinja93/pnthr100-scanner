import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function authHeaders() {
  const token = localStorage.getItem('pnthr_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const STATUS_COLOR = {
  FAILED:    '#dc3545',
  STUCK:     '#ff8c00',
  EXECUTING: '#5ab2ff',
  PENDING:   '#ffd24a',
  DONE:      '#7ed957',
  CANCELLED: '#888',
};

const STATUS_ORDER = { FAILED: 0, STUCK: 1, EXECUTING: 2, PENDING: 3, DONE: 4, CANCELLED: 5 };

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function cmdDetails(cmd) {
  const r = cmd.request || {};
  const parts = [];
  if (cmd.errors) {
    const e = cmd.errors;
    parts.push(typeof e === 'string' ? e : JSON.stringify(e));
  }
  if (r.direction) parts.push(r.direction);
  if (r.lot != null) parts.push(`L${r.lot}`);
  if (r.shares != null) parts.push(`${r.shares}sh`);
  if (r.stopPrice != null) parts.push(`stop $${r.stopPrice}`);
  if (r.triggerPrice != null) parts.push(`trigger $${r.triggerPrice}`);
  if (r.source) parts.push(r.source);
  return parts.join(' · ') || '—';
}

export default function PendingBridgeOrdersPanel({ collapsed, onToggle, style }) {
  const { isAdmin } = useAuth();
  const [data, setData] = useState({ counts: {}, commands: [], flags: {} });
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    try {
      setLoading(true);
      const r = await fetch(`${API_BASE}/api/admin/ibkr-outbox`, { headers: authHeaders() });
      if (r.ok) setData(await r.json());
    } catch (e) { /* ignore */ }
    finally { setLoading(false); }
  }, [isAdmin]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30000);
    return () => clearInterval(iv);
  }, [refresh]);

  const cancelOne = async (id) => {
    setActionLoading(id);
    try {
      await fetch(`${API_BASE}/api/admin/outbox-cancel-one`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await refresh();
    } catch (e) { /* ignore */ }
    finally { setActionLoading(null); }
  };

  const purgeAll = async () => {
    if (!window.confirm('Cancel ALL pending bridge commands?')) return;
    setActionLoading('purge');
    try {
      await fetch(`${API_BASE}/api/admin/outbox-purge-pending`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      await refresh();
    } catch (e) { /* ignore */ }
    finally { setActionLoading(null); }
  };

  if (!isAdmin) return null;

  const pending = data.counts?.PENDING || 0;
  const executing = data.counts?.EXECUTING || 0;
  const failed = data.counts?.FAILED || 0;
  const stuck = data.counts?.STUCK || 0;
  const totalActive = pending + executing;
  const hasProblems = failed > 0 || stuck > 0;

  const bridgeOnline = data.flags?.IBKR_AUTO_PLACE_STOP !== undefined;
  const lastDoneCmd = (data.commands || []).find(c => c.status === 'DONE');
  const lastDoneTime = lastDoneCmd?.executedAt || lastDoneCmd?.createdAt;

  const sorted = [...(data.commands || [])].sort((a, b) => {
    const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (s !== 0) return s;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  const pendingCmds = sorted.filter(c => c.status === 'PENDING');

  return (
    <div style={{
      border: `1px solid ${hasProblems ? 'rgba(220, 53, 69, 0.5)' : 'rgba(252, 240, 0, 0.18)'}`,
      borderRadius: 8,
      marginBottom: 16,
      background: hasProblems ? 'rgba(220, 53, 69, 0.04)' : 'rgba(252, 240, 0, 0.01)',
      ...style,
    }}>
      {/* Header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '7px 14px 5px', cursor: 'pointer', userSelect: 'none',
          borderBottom: !collapsed ? '1px solid rgba(252, 240, 0, 0.12)' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#FCF000', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em' }}>
            {collapsed ? '▶' : '▼'}
          </span>
          <span style={{ color: '#FCF000', fontSize: 13, fontWeight: 700, letterSpacing: '0.08em' }}>
            PENDING BRIDGE ORDERS
          </span>
          {/* Status indicator */}
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: hasProblems ? '#dc3545' : (totalActive > 0 ? '#ffd24a' : '#7ed957'),
            boxShadow: hasProblems ? '0 0 6px #dc3545' : (totalActive > 0 ? '0 0 6px #ffd24a' : 'none'),
          }} />
          {totalActive > 0 && (
            <span style={{ color: '#ffd24a', fontSize: 11, fontWeight: 600 }}>
              {totalActive} queued
            </span>
          )}
          {failed > 0 && (
            <span style={{ color: '#dc3545', fontSize: 11, fontWeight: 600 }}>
              {failed} failed
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {lastDoneTime && (
            <span style={{ color: '#666', fontSize: 10 }}>
              Last exec: {formatTime(lastDoneTime)}
            </span>
          )}
          {loading && <span style={{ color: '#888', fontSize: 10 }}>⟳</span>}
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{ padding: '6px 8px 10px' }}>
          {/* Bridge status bar */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '4px 8px', marginBottom: 8,
            background: 'rgba(0,0,0,0.3)', borderRadius: 6, fontSize: 11,
          }}>
            <div style={{ display: 'flex', gap: 16, color: '#bbb' }}>
              <span>PENDING: <b style={{ color: STATUS_COLOR.PENDING }}>{pending}</b></span>
              <span>EXECUTING: <b style={{ color: STATUS_COLOR.EXECUTING }}>{executing}</b></span>
              <span>FAILED: <b style={{ color: STATUS_COLOR.FAILED }}>{failed}</b></span>
              <span>DONE: <b style={{ color: STATUS_COLOR.DONE }}>{data.counts?.DONE || 0}</b></span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {pendingCmds.length > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); purgeAll(); }}
                  disabled={actionLoading === 'purge'}
                  style={{
                    background: '#dc3545', color: '#fff', border: 'none', borderRadius: 4,
                    padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                    opacity: actionLoading === 'purge' ? 0.5 : 1,
                  }}
                >
                  {actionLoading === 'purge' ? '...' : 'DELETE ALL'}
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); refresh(); }}
                style={{
                  background: 'rgba(252,240,0,0.15)', color: '#FCF000', border: '1px solid rgba(252,240,0,0.3)',
                  borderRadius: 4, padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                }}
              >
                REFRESH
              </button>
            </div>
          </div>

          {/* Commands table */}
          {sorted.length === 0 ? (
            <div style={{ color: '#666', textAlign: 'center', padding: 20, fontSize: 12 }}>
              No bridge commands in queue
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{
                width: '100%', borderCollapse: 'collapse', fontSize: 11,
                fontFamily: "'Inter', 'Segoe UI', sans-serif",
              }}>
                <thead>
                  <tr style={{ color: '#888', textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
                    <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.06em', width: 30 }}></th>
                    <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.06em' }}>STATUS</th>
                    <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.06em' }}>TIME</th>
                    <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.06em' }}>COMMAND</th>
                    <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.06em' }}>TICKER</th>
                    <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.06em' }}>DETAILS</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((cmd, i) => {
                    const isPending = cmd.status === 'PENDING';
                    return (
                      <tr key={cmd.id || cmd._id || i}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                          {isPending && (
                            <button
                              onClick={() => cancelOne(cmd.id)}
                              disabled={actionLoading === cmd.id}
                              title="Cancel this command"
                              style={{
                                background: 'none', border: 'none', color: '#dc3545',
                                cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: 0,
                                opacity: actionLoading === cmd.id ? 0.3 : 0.7,
                              }}
                              onMouseEnter={e => e.target.style.opacity = 1}
                              onMouseLeave={e => e.target.style.opacity = 0.7}
                            >
                              ✕
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '4px 8px', color: STATUS_COLOR[cmd.status] || '#888', fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {cmd.status}
                        </td>
                        <td style={{ padding: '4px 8px', color: '#bbb', whiteSpace: 'nowrap' }}>
                          {formatTime(cmd.createdAt)}
                        </td>
                        <td style={{ padding: '4px 8px', color: '#ddd', whiteSpace: 'nowrap' }}>
                          {cmd.command}
                        </td>
                        <td style={{ padding: '4px 8px', color: '#FCF000', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {cmd.request?.ticker || '—'}
                        </td>
                        <td style={{ padding: '4px 8px', color: cmd.errors ? '#ff8888' : '#aaa', maxWidth: 400, wordBreak: 'break-word' }}>
                          {cmdDetails(cmd)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
