import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../AuthContext';
import { fetchAmbushSummary, updateAmbushConfig, triggerAmbushTick, deleteAmbushPosition } from '../services/api';
import PageHeader from './PageHeader';
import styles from './AmbushPage.module.css';

const STATE_CONFIG = {
  STALKING: {
    label: 'STALKING',
    color: '#a78bfa',
    bg: 'rgba(167, 139, 250, 0.08)',
    border: 'rgba(167, 139, 250, 0.3)',
    desc: 'Watching for first-hour low break',
    icon: '👁',
  },
  ATTACK: {
    label: 'ATTACK',
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.08)',
    border: 'rgba(245, 158, 11, 0.3)',
    desc: 'Breakout confirmed, entry queued',
    icon: '⚡',
  },
  ACTIVE: {
    label: 'ACTIVE',
    color: '#22c55e',
    bg: 'rgba(34, 197, 94, 0.08)',
    border: 'rgba(34, 197, 94, 0.3)',
    desc: 'Position open, lots loading',
    icon: '🎯',
  },
  PROTECT: {
    label: 'PROTECT',
    color: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.08)',
    border: 'rgba(59, 130, 246, 0.3)',
    desc: 'Break Even hit, trailing stop active',
    icon: '🛡',
  },
};

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '--';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtPnl(n) {
  if (n == null || isNaN(n)) return '--';
  const color = n >= 0 ? '#22c55e' : '#ef4444';
  const prefix = n >= 0 ? '+' : '';
  return <span style={{ color, fontWeight: 600 }}>{prefix}{fmtUsd(n)}</span>;
}

function PositionCard({ pos, onRemove }) {
  const isLong = pos.direction === 'LONG';
  const dirColor = isLong ? '#22c55e' : '#ef4444';
  const stateConf = STATE_CONFIG[pos.state] || STATE_CONFIG.ACTIVE;

  // Calculate unrealized P&L estimate (rough, based on entry vs stop)
  const lotsFilledText = pos.nextLot != null ? `L${pos.nextLot}/5` : '--';

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardTicker}>
          <span style={{ color: dirColor, fontWeight: 700, fontSize: 11, marginRight: 6 }}>
            {isLong ? 'LONG' : 'SHORT'}
          </span>
          <span className={styles.tickerName}>{pos.ticker}</span>
        </div>
        {onRemove && (
          <button className={styles.removeBtn} onClick={() => onRemove(pos.ticker)} title="Remove">x</button>
        )}
      </div>
      <div className={styles.cardBody}>
        {pos.state === 'ACTIVE' || pos.state === 'PROTECT' ? (
          <>
            <div className={styles.cardRow}>
              <span className={styles.cardLabel}>Entry</span>
              <span>{fmtUsd(pos.entryPrice)}</span>
            </div>
            <div className={styles.cardRow}>
              <span className={styles.cardLabel}>Avg Cost</span>
              <span>{fmtUsd(pos.avgCost)}</span>
            </div>
            <div className={styles.cardRow}>
              <span className={styles.cardLabel}>Shares</span>
              <span>{pos.totalShares || 0}</span>
            </div>
            <div className={styles.cardRow}>
              <span className={styles.cardLabel}>Stop</span>
              <span style={{ color: '#ef4444' }}>{fmtUsd(pos.stop)}</span>
            </div>
            <div className={styles.cardRow}>
              <span className={styles.cardLabel}>Lots</span>
              <span>{lotsFilledText}</span>
            </div>
            {pos.atBE && (
              <div className={styles.cardRow}>
                <span className={styles.cardLabel}>Break Even</span>
                <span style={{ color: '#3b82f6' }}>YES</span>
              </div>
            )}
            {pos.trailingActive && (
              <div className={styles.cardRow}>
                <span className={styles.cardLabel}>Trailing</span>
                <span style={{ color: '#3b82f6' }}>ACTIVE</span>
              </div>
            )}
            {pos.peak > 0 && (
              <div className={styles.cardRow}>
                <span className={styles.cardLabel}>Peak P&L</span>
                <span style={{ color: '#22c55e' }}>{fmtUsd(pos.peak)}</span>
              </div>
            )}
          </>
        ) : pos.state === 'STALKING' ? (
          <>
            <div className={styles.cardRow}>
              <span className={styles.cardLabel}>Cycle</span>
              <span>#{(pos.cycleNum || 0) + 1}</span>
            </div>
            {pos.runningLow && (
              <div className={styles.cardRow}>
                <span className={styles.cardLabel}>Low</span>
                <span>{fmtUsd(pos.runningLow)}</span>
              </div>
            )}
            {pos.runningHigh && (
              <div className={styles.cardRow}>
                <span className={styles.cardLabel}>High</span>
                <span>{fmtUsd(pos.runningHigh)}</span>
              </div>
            )}
          </>
        ) : pos.state === 'ATTACK' ? (
          <>
            <div className={styles.cardRow}>
              <span className={styles.cardLabel}>Status</span>
              <span style={{ color: '#f59e0b' }}>Entry Queued</span>
            </div>
            <div className={styles.cardRow}>
              <span className={styles.cardLabel}>Cycle</span>
              <span>#{(pos.cycleNum || 0) + 1}</span>
            </div>
          </>
        ) : null}
        <div className={styles.cardDate}>
          {pos.entryDate || pos.updatedAt?.split('T')[0] || ''}
        </div>
      </div>
    </div>
  );
}

function StateBox({ state, positions, onRemove }) {
  const conf = STATE_CONFIG[state];
  const count = positions.length;

  return (
    <div className={styles.stateBox} style={{ borderColor: conf.border, background: conf.bg }}>
      <div className={styles.stateHeader} style={{ borderBottomColor: conf.border }}>
        <div className={styles.stateTitle}>
          <span className={styles.stateIcon}>{conf.icon}</span>
          <span style={{ color: conf.color }}>{conf.label}</span>
          <span className={styles.stateCount} style={{ background: conf.color }}>{count}</span>
        </div>
        <div className={styles.stateDesc}>{conf.desc}</div>
      </div>
      <div className={styles.stateCards}>
        {positions.length === 0 ? (
          <div className={styles.emptyState}>No tickers in {conf.label}</div>
        ) : (
          positions.map(pos => (
            <PositionCard key={pos.ticker} pos={pos} onRemove={onRemove} />
          ))
        )}
      </div>
    </div>
  );
}

function RecentTradesTable({ trades }) {
  if (!trades || trades.length === 0) return null;

  return (
    <div className={styles.tradesSection}>
      <h3 className={styles.sectionTitle}>Recent Trades</h3>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Dir</th>
            <th style={{ textAlign: 'right' }}>Entry</th>
            <th style={{ textAlign: 'right' }}>Exit</th>
            <th style={{ textAlign: 'right' }}>Shares</th>
            <th style={{ textAlign: 'right' }}>P&L</th>
            <th>Exit Type</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={i}>
              <td style={{ fontWeight: 600 }}>{t.ticker}</td>
              <td>
                <span style={{ color: t.direction === 'LONG' ? '#22c55e' : '#ef4444', fontSize: 11, fontWeight: 600 }}>
                  {t.direction}
                </span>
              </td>
              <td style={{ textAlign: 'right' }}>{fmtUsd(t.entryPrice)}</td>
              <td style={{ textAlign: 'right' }}>{fmtUsd(t.exitPrice)}</td>
              <td style={{ textAlign: 'right' }}>{t.shares}</td>
              <td style={{ textAlign: 'right' }}>{fmtPnl(t.pnl)}</td>
              <td style={{ fontSize: 11, color: '#888' }}>{t.exitType}</td>
              <td style={{ fontSize: 11, color: '#888' }}>{t.exitDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AmbushPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tickRunning, setTickRunning] = useState(false);
  const refreshRef = useRef(null);

  const loadData = useCallback(async () => {
    try {
      const summary = await fetchAmbushSummary();
      setData(summary);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    // Auto-refresh every 60 seconds
    refreshRef.current = setInterval(loadData, 60000);
    return () => clearInterval(refreshRef.current);
  }, [loadData]);

  const handleToggle = async () => {
    if (!data?.config) return;
    try {
      await updateAmbushConfig({ enabled: !data.config.enabled });
      await loadData();
    } catch (err) {
      alert('Failed to toggle: ' + err.message);
    }
  };

  const handleManualTick = async () => {
    setTickRunning(true);
    try {
      const result = await triggerAmbushTick();
      console.log('[Ambush] Manual tick result:', result);
      await loadData();
    } catch (err) {
      alert('Tick failed: ' + err.message);
    } finally {
      setTickRunning(false);
    }
  };

  const handleRemovePosition = async (ticker) => {
    if (!confirm(`Remove ${ticker} from Ambush?`)) return;
    try {
      await deleteAmbushPosition(ticker);
      await loadData();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
  };

  if (loading) {
    return (
      <div className={styles.page}>
        <PageHeader title="PNTHR AMBUSH" />
        <div className={styles.loading}>Loading Ambush data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.page}>
        <PageHeader title="PNTHR AMBUSH" />
        <div className={styles.error}>Error: {error}</div>
      </div>
    );
  }

  const positions = data?.positions || [];
  const config = data?.config || {};
  const stats = data?.stats || {};
  const recentTrades = data?.recentTrades || [];

  const byState = {
    STALKING: positions.filter(p => p.state === 'STALKING'),
    ATTACK: positions.filter(p => p.state === 'ATTACK'),
    ACTIVE: positions.filter(p => p.state === 'ACTIVE'),
    PROTECT: positions.filter(p => p.state === 'PROTECT'),
  };

  return (
    <div className={styles.page}>
      <PageHeader title="PNTHR AMBUSH" />

      {/* ── Control Bar ── */}
      <div className={styles.controlBar}>
        <div className={styles.statusRow}>
          <button
            className={`${styles.toggleBtn} ${config.enabled ? styles.toggleOn : styles.toggleOff}`}
            onClick={handleToggle}
          >
            {config.enabled ? 'LIVE' : 'OFF'}
          </button>
          <span className={styles.navLabel}>NAV: {fmtUsd(config.nav)}</span>
          {config.lastCronRun && (
            <span className={styles.lastRun}>
              Last tick: {new Date(config.lastCronRun).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className={styles.statsRow}>
          <span className={styles.stat}>
            Trades: <strong>{stats.totalTrades || 0}</strong>
          </span>
          <span className={styles.stat}>
            Win Rate: <strong>{stats.winRate || 0}%</strong>
          </span>
          <span className={styles.stat}>
            P&L: {fmtPnl(stats.totalPnl)}
          </span>
          <button
            className={styles.tickBtn}
            onClick={handleManualTick}
            disabled={tickRunning}
          >
            {tickRunning ? 'Running...' : 'Manual Tick'}
          </button>
        </div>
      </div>

      {/* ── Flow indicator ── */}
      <div className={styles.flowRow}>
        {['STALKING', 'ATTACK', 'ACTIVE', 'PROTECT'].map((state, i) => (
          <div key={state} className={styles.flowItem}>
            {i > 0 && <span className={styles.flowArrow}>→</span>}
            <span style={{ color: STATE_CONFIG[state].color, fontWeight: 700 }}>
              {STATE_CONFIG[state].icon} {state}
            </span>
            <span className={styles.flowCount}>{byState[state].length}</span>
          </div>
        ))}
      </div>

      {/* ── Kanban Board ── */}
      <div className={styles.kanban}>
        {['STALKING', 'ATTACK', 'ACTIVE', 'PROTECT'].map(state => (
          <StateBox
            key={state}
            state={state}
            positions={byState[state]}
            onRemove={isAdmin ? handleRemovePosition : null}
          />
        ))}
      </div>

      {/* ── Recent Trades ── */}
      <RecentTradesTable trades={recentTrades} />
    </div>
  );
}
