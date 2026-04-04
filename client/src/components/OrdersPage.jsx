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
  const slopeStr = emaSlope != null ? emaSlope.toFixed(2) : '—';
  return (
    <span>
      <strong>{label}</strong>{' '}
      ${price?.toFixed(2) || '—'} <span className={cls}>{dir} EMA</span>{' '}
      <span style={{ color: '#888' }}>${ema21?.toFixed(2) || '—'}</span>{' '}
      (slope <span className={emaSlope > 0 ? styles.bullish : emaSlope < 0 ? styles.bearish : ''}>{slopeStr}%</span>)
    </span>
  );
}

// ── Rules popup content ─────────────────────────────────────────────────────

function RulesPopup({ type, onClose }) {
  return (
    <div className={styles.rulesOverlay} onClick={onClose}>
      <div className={styles.rulesPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.rulesHeader}>
          <h2 className={styles.rulesTitle}>
            {type === 'BL' ? 'BUY LONG Order Rules' : 'SELL SHORT Order Rules'}
          </h2>
          <button className={styles.rulesClose} onClick={onClose}>X</button>
        </div>

        {type === 'BL' ? (
          <div className={styles.rulesBody}>
            <h3 className={styles.rulesSectionTitle}>Filter Gates (must pass ALL)</h3>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>1</div>
              <div>
                <div className={styles.ruleName}>Active BL Signal</div>
                <div className={styles.ruleDesc}>Stock must have a confirmed Buy Long signal (close {'>'} 21W EMA, slope up, high {'>='} 2-week high, 1-10% daylight above EMA)</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>2</div>
              <div>
                <div className={styles.ruleName}>MACRO Gate — Index Above 21W EMA</div>
                <div className={styles.ruleDesc}>SPY (NYSE stocks) or QQQ (NASDAQ stocks) must be trading ABOVE its 21-week EMA. If the index is below EMA, all longs in that exchange are blocked.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>3</div>
              <div>
                <div className={styles.ruleName}>SECTOR Gate — Sector ETF Above 21W EMA</div>
                <div className={styles.ruleDesc}>The stock's sector ETF (e.g., XLK for Technology, XLF for Financials) must be trading ABOVE its 21-week EMA. Buying longs in a sector that's in a downtrend is blocked.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>4</div>
              <div>
                <div className={styles.ruleName}>D2 Gate — Sector Direction Score {'>='} 0</div>
                <div className={styles.ruleDesc}>The Kill scoring D2 dimension (sector momentum) must be non-negative. A negative D2 means the sector has headwinds — longs are blocked.</div>
              </div>
            </div>

            <h3 className={styles.rulesSectionTitle}>Ranking (after filtering)</h3>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>5</div>
              <div>
                <div className={styles.ruleName}>Re-rank by Kill Score</div>
                <div className={styles.ruleDesc}>All BL stocks that pass gates 1-4 are re-ranked by their Kill score (D1-D8 composite). This filtered rank may differ from the full-universe Kill rank.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>6</div>
              <div>
                <div className={styles.ruleName}>Top 10 Selected</div>
                <div className={styles.ruleDesc}>Only the top 10 BL stocks by filtered Kill score are selected for orders. All others are passed over.</div>
              </div>
            </div>

            <h3 className={styles.rulesSectionTitle}>Execution</h3>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>7</div>
              <div>
                <div className={styles.ruleName}>GTD Limit Order</div>
                <div className={styles.ruleDesc}>Enter via GTD (Good-Til-Date) limit order in IBKR at the signal price level, expiring next Friday. If the order doesn't fill, the breakout never happened — system protected you.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>8</div>
              <div>
                <div className={styles.ruleName}>Lot 1 Entry ($10K)</div>
                <div className={styles.ruleDesc}>Initial position is Lot 1 only (35% of full size). Lots 2-5 are added via pyramiding: 5-day time gate + 1% profitable trigger. Stop ratchets on each lot fill.</div>
              </div>
            </div>

            <h3 className={styles.rulesSectionTitle}>Backtest Performance</h3>

            <div className={styles.ruleCard} style={{ borderLeft: '3px solid #fcf000' }}>
              <div>
                <div className={styles.ruleName}>Filter-Then-Rank Backtest Results</div>
                <div className={styles.ruleDesc}>
                  67.2% win rate (78.6% dollar-weighted) | +5.49% avg P&L per trade | W/L ratio 3.35:1 | Positive every year including 2022. Results independent of lot size.
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.rulesBody}>
            <h3 className={styles.rulesSectionTitle}>Filter Gates (must pass ALL)</h3>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>1</div>
              <div>
                <div className={styles.ruleName}>Active SS Signal</div>
                <div className={styles.ruleDesc}>Stock must have a confirmed Sell Short signal (close {'<'} 21W EMA, slope down, low {'<='} 2-week low, 1-10% below EMA)</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>2</div>
              <div>
                <div className={styles.ruleName}>MACRO Gate — Index Below 21W EMA</div>
                <div className={styles.ruleDesc}>SPY (NYSE stocks) or QQQ (NASDAQ stocks) must be trading BELOW its 21-week EMA. Shorting when the index is in an uptrend is blocked.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>3</div>
              <div>
                <div className={styles.ruleName}>SECTOR Gate — Sector ETF Below 21W EMA</div>
                <div className={styles.ruleDesc}>The stock's sector ETF must be trading BELOW its 21-week EMA. Shorting in a sector that's trending up is blocked.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>4</div>
              <div>
                <div className={styles.ruleName}>D2 Gate — Sector Direction Score {'>='} 0</div>
                <div className={styles.ruleDesc}>The Kill scoring D2 dimension must be non-negative for the short direction. A negative D2 means the sector isn't confirming the downtrend.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>5</div>
              <div>
                <div className={styles.ruleName}>SS CRASH Gate — Extreme Conditions Required</div>
                <div className={styles.ruleDesc}>
                  Shorts require CRASH conditions (both must be true):
                  <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                    <li>Macro EMA slope falling (SPY 21W EMA declining)</li>
                    <li>Sector 5D momentum {'<'} -3% (sector ETF dropped 3%+ in 5 trading days)</li>
                  </ul>
                  This is the key asymmetric gate — SS only enters during genuine market breakdowns, not mild pullbacks.
                </div>
              </div>
            </div>

            <h3 className={styles.rulesSectionTitle}>Ranking (after filtering)</h3>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>6</div>
              <div>
                <div className={styles.ruleName}>Re-rank by Kill Score</div>
                <div className={styles.ruleDesc}>All SS stocks that pass gates 1-5 are re-ranked by Kill score within the filtered pool.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>7</div>
              <div>
                <div className={styles.ruleName}>Top 5 Selected</div>
                <div className={styles.ruleDesc}>Only the top 5 SS stocks by filtered Kill score are selected. Shorts are intentionally capped at 5 (vs 10 for longs) because crash conditions are rare and concentrated.</div>
              </div>
            </div>

            <h3 className={styles.rulesSectionTitle}>Execution</h3>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>8</div>
              <div>
                <div className={styles.ruleName}>GTD Limit Order</div>
                <div className={styles.ruleDesc}>Enter via GTD limit order in IBKR at the signal price level, expiring next Friday. Unfilled = breakdown never confirmed.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>9</div>
              <div>
                <div className={styles.ruleName}>Lot 1 Entry ($10K) + Pyramiding</div>
                <div className={styles.ruleDesc}>Same lot system as longs: Lot 1 at 35%, then Lots 2-5 with 5-day gate + 1% profitable trigger. Stop ratchets DOWN on each lot fill (only tightens for shorts).</div>
              </div>
            </div>

            <h3 className={styles.rulesSectionTitle}>Backtest Performance</h3>

            <div className={styles.ruleCard} style={{ borderLeft: '3px solid #fcf000' }}>
              <div>
                <div className={styles.ruleName}>Filter-Then-Rank Backtest Results</div>
                <div className={styles.ruleDesc}>
                  67.2% win rate (78.6% dollar-weighted) | +5.49% avg P&L per trade | W/L ratio 3.35:1 | Positive every year including 2022. The strict crash gate is what makes SS work — the first time shorts have outperformed in any PNTHR backtest.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function OrdersPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('orders');
  const [rulesPopup, setRulesPopup] = useState(null); // 'BL' | 'SS' | null
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
          <div className={styles.rulesButtons}>
            <button className={styles.rulesBtn} onClick={() => setRulesPopup('BL')}>BL Order Rules</button>
            <button className={`${styles.rulesBtn} ${styles.rulesBtnSS}`} onClick={() => setRulesPopup('SS')}>SS Order Rules</button>
          </div>
        </div>
      </div>

      {rulesPopup && <RulesPopup type={rulesPopup} onClose={() => setRulesPopup(null)} />}

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
