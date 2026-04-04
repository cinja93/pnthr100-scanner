import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestOrders, fetchOrdersHistory, fetchOrdersGateLog, runOrdersManual } from '../services/api';
import styles from './OrdersPage.module.css';
import pantherHead from '../assets/panther head.png';

// Next Friday date string for GTD orders
function nextFriday() {
  const d = new Date();
  const day = d.getDay();
  const diff = (5 - day + 7) % 7 || 7; // days until next Friday (or 7 if today is Friday)
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function MacroRow({ label, price, ema21, aboveEma, emaSlope }) {
  const dir = aboveEma ? 'ABOVE' : 'BELOW';
  const cls = aboveEma ? styles.bullish : styles.bearish;
  return (
    <span>
      <strong>{label}</strong>{' '}
      ${price?.toFixed(2)} <span className={cls}>{dir} EMA</span>{' '}
      (slope {emaSlope?.toFixed(2)}%)
    </span>
  );
}

export default function OrdersPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('orders');
  const [gateData, setGateData] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await fetchLatestOrders();
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Lazy-load tabs
  useEffect(() => {
    if (tab === 'gates' && !gateData) {
      fetchOrdersGateLog().then(setGateData).catch(() => {});
    }
    if (tab === 'history' && !history) {
      fetchOrdersHistory().then(d => setHistory(d.history)).catch(() => {});
    }
  }, [tab, gateData, history]);

  async function handleManualRun(type) {
    setRunning(true);
    try {
      await runOrdersManual(type);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <div className={styles.loading}>Loading orders...</div>;
  if (error) return <div className={styles.error}>Error: {error}</div>;
  if (!data) return <div className={styles.empty}><p className={styles.emptyTitle}>No order data</p></div>;

  const { regime, mode, orders, stats, sectorSummary, dailyUpdates, type: docType, generatedAt } = data;

  const blOrders = orders.filter(o => o.signal === 'BL');
  const ssOrders = orders.filter(o => o.signal === 'SS');
  const gtdExp = nextFriday();

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <img src={pantherHead} alt="" className={styles.panther} />
            <h1 className={styles.title}>PNTHR Orders</h1>
          </div>
          <p className={styles.subtitle}>
            Filter-then-rank order sheet — {data.weekOf || 'current week'}
          </p>
        </div>
        <div className={styles.headerRight}>
          {docType && (
            <span className={`${styles.badge} ${
              docType === 'CONFIRMED' ? styles.badgeConfirmed :
              docType === 'DAILY_UPDATE' ? styles.badgeDailyUpdate :
              styles.badgePreview
            }`}>
              {docType}
            </span>
          )}
          <span className={styles.timestamp}>{formatDate(generatedAt)}</span>
        </div>
      </div>

      {/* Admin controls */}
      {isAdmin && (
        <div className={styles.adminBar}>
          <button className={styles.adminBtn} disabled={running} onClick={() => handleManualRun('WEEKLY')}>
            {running ? 'Running...' : 'Run PREVIEW'}
          </button>
          <button className={styles.adminBtn} disabled={running} onClick={() => handleManualRun('CONFIRMED')}>
            {running ? 'Running...' : 'Run CONFIRMED'}
          </button>
        </div>
      )}

      {/* Regime / Macro Bar */}
      {regime && (
        <div className={styles.regimeBar}>
          <span className={styles.regimeLabel}>MACRO</span>
          <MacroRow label="SPY" price={regime.spyPrice} ema21={regime.spyEma21} aboveEma={regime.spyAboveEma} emaSlope={regime.spyEmaSlope} />
          <span style={{ color: '#555' }}>|</span>
          <MacroRow label="QQQ" price={regime.qqqPrice} ema21={regime.qqqEma21} aboveEma={regime.qqqAboveEma} emaSlope={regime.qqqEmaSlope} />
          <span style={{ color: '#555' }}>|</span>
          <span>
            <span className={styles.regimeLabel}>MODE </span>
            <span className={`${styles.regimeValue} ${
              mode === 'NO TRADES' ? styles.neutral :
              mode === 'CRASH MODE' ? styles.bearish :
              styles.bullish
            }`}>{mode}</span>
          </span>
        </div>
      )}

      {/* Stats Row */}
      {stats && (
        <div className={styles.statsRow}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Scored</span>
            <span className={styles.statValue}>{stats.totalScored}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Signals</span>
            <span className={styles.statValue}>{stats.withSignals}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Macro Filtered</span>
            <span className={styles.statValue}>{stats.macroFiltered}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Sector Filtered</span>
            <span className={styles.statValue}>{stats.sectorFiltered}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>D2 Filtered</span>
            <span className={styles.statValue}>{stats.d2Filtered}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>SS Crash Filtered</span>
            <span className={styles.statValue}>{stats.ssCrashFiltered}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Survivors</span>
            <span className={styles.statValue}>{stats.survivors}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>BL Selected</span>
            <span className={styles.statValue} style={{ color: '#22c55e' }}>{stats.blSelected}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>SS Selected</span>
            <span className={styles.statValue} style={{ color: '#ef4444' }}>{stats.ssSelected}</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className={styles.tabs}>
        <button className={`${styles.tab} ${tab === 'orders' ? styles.tabActive : ''}`} onClick={() => setTab('orders')}>
          Orders ({orders.length})
        </button>
        <button className={`${styles.tab} ${tab === 'sectors' ? styles.tabActive : ''}`} onClick={() => setTab('sectors')}>
          Sectors
        </button>
        {dailyUpdates?.length > 0 && (
          <button className={`${styles.tab} ${tab === 'daily' ? styles.tabActive : ''}`} onClick={() => setTab('daily')}>
            Daily Updates ({dailyUpdates.length})
          </button>
        )}
        <button className={`${styles.tab} ${tab === 'gates' ? styles.tabActive : ''}`} onClick={() => setTab('gates')}>
          Gate Log
        </button>
        <button className={`${styles.tab} ${tab === 'history' ? styles.tabActive : ''}`} onClick={() => setTab('history')}>
          History
        </button>
      </div>

      {/* ── Orders Tab ──────────────────────────────────────────────────────── */}
      {tab === 'orders' && (
        <>
          {orders.length === 0 ? (
            <div className={styles.noTrade}>
              <p className={styles.noTradeTitle}>NO TRADES THIS WEEK</p>
              <p className={styles.noTradeMsg}>
                All conditions did not line up. The system is protecting your capital.
              </p>
            </div>
          ) : (
            <>
              {/* BL Orders */}
              {blOrders.length > 0 && (
                <div className={styles.gateSection}>
                  <h3 className={styles.gateSectionTitle}>BUY LONG ({blOrders.length})</h3>
                  <OrderTable orders={blOrders} gtdExp={gtdExp} />
                </div>
              )}

              {/* SS Orders */}
              {ssOrders.length > 0 && (
                <div className={styles.gateSection}>
                  <h3 className={styles.gateSectionTitle}>SELL SHORT ({ssOrders.length})</h3>
                  <OrderTable orders={ssOrders} gtdExp={gtdExp} />
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Sectors Tab ─────────────────────────────────────────────────────── */}
      {tab === 'sectors' && (
        <div className={styles.sectorGrid}>
          {Object.entries(sectorSummary || {}).map(([etf, s]) => (
            <div key={etf} className={styles.sectorCard}>
              <span className={styles.sectorEtf}>{etf}</span>
              <span className={s.aboveEma ? styles.sectorAligned : styles.sectorBlocked}>
                {s.aboveEma ? 'ABOVE EMA' : 'BELOW EMA'}
              </span>
              <span className={styles.sector5d}> 5D: {s.return5D?.toFixed(1)}%</span>
              <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{s.sector}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Daily Updates Tab ───────────────────────────────────────────────── */}
      {tab === 'daily' && (
        <div className={styles.dailySection}>
          {(dailyUpdates || []).map((u, i) => (
            <div key={i} className={styles.dailyCard}>
              <div className={`${styles.dailyType} ${
                u.action === 'EXIT' ? styles.exitAlert :
                u.action === 'ADD_LOT' ? styles.lotAdd :
                styles.staleHunt
              }`}>
                {u.action} — {u.ticker} ({u.signal})
              </div>
              <div className={styles.dailyMsg}>{u.reason}</div>
              <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                Day {u.tradingDays} | Lots filled: {u.filledLots}
                {u.nextLot && ` | Next: Lot ${u.nextLot}`}
                {u.timeGateCleared && ' | Time gate cleared'}
              </div>
            </div>
          ))}
          {(!dailyUpdates || dailyUpdates.length === 0) && (
            <div className={styles.noTrade}>
              <p className={styles.noTradeTitle}>No daily updates</p>
              <p className={styles.noTradeMsg}>No lot additions or exits triggered today.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Gate Log Tab ────────────────────────────────────────────────────── */}
      {tab === 'gates' && (
        <div className={styles.gateSection}>
          {gateData ? (
            <>
              <div className={styles.gateLog}>
                {(gateData.gateLog || []).map((g, i) => (
                  <div key={i} className={g.passed ? styles.gatePass : styles.gateFail}>
                    {g.passed ? 'PASS' : 'FAIL'} [{g.gate}] {g.ticker} ({g.signal}) — {g.reason}
                  </div>
                ))}
                {(!gateData.gateLog || gateData.gateLog.length === 0) && (
                  <div style={{ color: '#666' }}>No gate log data available.</div>
                )}
              </div>
            </>
          ) : (
            <div className={styles.loading}>Loading gate log...</div>
          )}
        </div>
      )}

      {/* ── History Tab ─────────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className={styles.gateSection}>
          {history ? (
            history.length > 0 ? (
              history.map((doc, i) => (
                <div key={i} className={styles.dailyCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontWeight: 700, color: '#fcf000' }}>{doc.weekOf}</span>
                      <span className={`${styles.badge} ${
                        doc.type === 'CONFIRMED' ? styles.badgeConfirmed : styles.badgePreview
                      }`} style={{ marginLeft: 8 }}>
                        {doc.type}
                      </span>
                    </div>
                    <span className={`${styles.regimeValue} ${
                      doc.mode === 'NO TRADES' ? styles.neutral :
                      doc.mode === 'CRASH MODE' ? styles.bearish :
                      styles.bullish
                    }`}>{doc.mode}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
                    {doc.orders?.length || 0} orders ({doc.stats?.blSelected || 0} BL, {doc.stats?.ssSelected || 0} SS)
                    {' | '}{doc.stats?.survivors || 0} survivors from {doc.stats?.totalScored || 0} scored
                  </div>
                  {doc.orders?.length > 0 && (
                    <div style={{ fontSize: 12, color: '#ccc', marginTop: 4 }}>
                      {doc.orders.map(o => (
                        <span key={o.ticker} style={{ marginRight: 10 }}>
                          <span className={o.signal === 'BL' ? styles.dirBL : styles.dirSS}>
                            {o.signal}
                          </span>{' '}{o.ticker}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className={styles.noTrade}>
                <p className={styles.noTradeTitle}>No history yet</p>
                <p className={styles.noTradeMsg}>Order sheets will appear here after the first Friday run.</p>
              </div>
            )
          ) : (
            <div className={styles.loading}>Loading history...</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Order table sub-component ──────────────────────────────────────────────────

function OrderTable({ orders, gtdExp }) {
  return (
    <table className={styles.ordersTable}>
      <thead>
        <tr>
          <th>#</th>
          <th>Ticker</th>
          <th>Action</th>
          <th>Kill Score</th>
          <th>Tier</th>
          <th>Entry (Limit)</th>
          <th>Stop</th>
          <th>Sector</th>
          <th>D2</th>
          <th>RSI</th>
          <th>GTD Expiry</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o, i) => (
          <tr key={o.ticker}>
            <td>{o.filteredRank}</td>
            <td>
              <strong>{o.ticker}</strong>
              <div style={{ fontSize: 11, color: '#666' }}>{o.companyName}</div>
            </td>
            <td>
              <span className={o.signal === 'BL' ? styles.dirBL : styles.dirSS}>
                {o.signal === 'BL' ? 'BUY' : 'SHORT'}
              </span>
            </td>
            <td className={styles.killScore}>{o.killScore}</td>
            <td>
              <span className={styles.tierCell} style={{
                background: tierColor(o.tier),
                color: tierTextColor(o.tier),
              }}>
                {o.tier}
              </span>
            </td>
            <td className={styles.entryPrice}>${o.signalPrice?.toFixed(2) || o.currentPrice?.toFixed(2) || '—'}</td>
            <td className={styles.stopPrice}>${o.stopPrice?.toFixed(2) || '—'}</td>
            <td style={{ fontSize: 12 }}>{o.sector}</td>
            <td style={{ color: (o.d2Score ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>{o.d2Score?.toFixed(0) ?? '—'}</td>
            <td style={{ fontSize: 12 }}>{o.weeklyRsi?.toFixed(0) || '—'}</td>
            <td className={styles.gtdDate}>{gtdExp}</td>
            <td>
              {o.inPortfolio
                ? <span style={{ color: '#2563eb', fontWeight: 600, fontSize: 11 }}>IN PORTFOLIO</span>
                : <span style={{ color: '#22c55e', fontWeight: 600, fontSize: 11 }}>NEW</span>
              }
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Tier color helpers (mirrors ApexPage) ────────────────────────────────────

const TIER_COLORS = {
  'ALPHA PNTHR KILL': { bg: '#15803d', text: '#fff' },
  'STRIKING':         { bg: '#16a34a', text: '#fff' },
  'HUNTING':          { bg: '#22c55e', text: '#111' },
  'POUNCING':         { bg: '#86efac', text: '#111' },
  'COILING':          { bg: '#ca8a04', text: '#fff' },
  'STALKING':         { bg: '#eab308', text: '#111' },
  'TRACKING':         { bg: '#fde047', text: '#111' },
  'PROWLING':         { bg: '#b91c1c', text: '#fff' },
  'STIRRING':         { bg: '#ef4444', text: '#fff' },
  'DORMANT':          { bg: '#fca5a5', text: '#111' },
};

function tierColor(tier) { return TIER_COLORS[tier]?.bg || '#333'; }
function tierTextColor(tier) { return TIER_COLORS[tier]?.text || '#ccc'; }
