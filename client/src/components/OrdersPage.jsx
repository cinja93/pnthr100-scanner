import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestOrders, fetchOrdersHistory, fetchOrdersGateLog, runOrdersManual, fetchBacktestTrades } from '../services/api';
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

            <h3 className={styles.rulesSectionTitle}>Kill Score — 8 Dimensions</h3>
            <div className={styles.ruleDesc} style={{ marginBottom: 10, color: '#888', fontSize: 12 }}>
              Formula: <strong style={{ color: '#fff' }}>Total = (D2 + D3 + D4 + D5 + D6 + D7 + D8) × D1</strong>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D1</div>
              <div>
                <div className={styles.ruleName}>Regime Multiplier (0.70–1.30×)</div>
                <div className={styles.ruleDesc}>Scales entire score by macro regime. Index EMA position + slope scored ±2, plus SS:BL ratio adjustments. regimeScore × 0.06 = adjustment. BL: 1.0 + adj; SS: 1.0 − adj.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D2</div>
              <div>
                <div className={styles.ruleName}>Sector Alignment (±15 pts, capped)</div>
                <div className={styles.ruleDesc}>5D component: |return5D%| × newMult × direction × 2 (new signals get 2×). 1M component: |return1M%| × direction. Total capped ±15.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D3</div>
              <div>
                <div className={styles.ruleName}>Entry Quality (0–85 pts) — THE KEY DIMENSION</div>
                <div className={styles.ruleDesc}>Sub-A: Close conviction (cap 40 pts). Sub-B: EMA slope × 10, signal direction only (cap 30 pts). Sub-C: EMA separation bell curve — sweet spot 2-8% (up to 15 pts), decays 8-20%, 20%+ = OVEREXTENDED (score −99). Confirmation: ≥30=CONFIRMED, ≥15=PARTIAL, {'<'}15=UNCONFIRMED.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D4</div>
              <div>
                <div className={styles.ruleName}>Signal Freshness (−15 to +10 pts)</div>
                <div className={styles.ruleDesc}>New signals earn bonus scaled by D3 confirmation. Age 0 CONFIRMED: +10, PARTIAL: +6, UNCONFIRMED: +3. Decays to 0 by week 3–5, then −3/wk through week 9, smooth decay to floor −15.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D5</div>
              <div>
                <div className={styles.ruleName}>Rank Rise (±20 pts, capped)</div>
                <div className={styles.ruleDesc}>+1/-1 per position change in Kill rank week-over-week. New entries start at 0. Capped ±20 — 55% of +30 rank jumps revert the following week.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D6</div>
              <div>
                <div className={styles.ruleName}>Momentum (−10 to +20 pts)</div>
                <div className={styles.ruleDesc}>Sub-A RSI: ±5 pts (inverted for SS). Sub-B OBV week-over-week: ±5 pts. Sub-C ADX: 0–5 pts when rising above 15. Sub-D Volume: +5 if ratio {'>'} 1.5×. Floor −10, cap +20.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D7</div>
              <div>
                <div className={styles.ruleName}>Rank Velocity (±10 pts)</div>
                <div className={styles.ruleDesc}>Acceleration of rank movement: velocity = currentRankChange − previousRankChange. Score = clip(round(velocity ÷ 6), −10, +10). Rising faster than last week = positive.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D8</div>
              <div>
                <div className={styles.ruleName}>Prey Presence (0–6 pts)</div>
                <div className={styles.ruleDesc}>SPRINT/HUNT +2 pts each. FEAST/ALPHA/SPRING/SNEAK +1 pt each. Maximum 6 pts. Acts as tiebreaker — most of the 679 universe scores 0 here.</div>
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
                <div className={styles.ruleName}>Lot 1 Entry</div>
                <div className={styles.ruleDesc}>Initial position is Lot 1 only (35% of full size). Lots 2-5 are added via pyramiding: 5-day time gate + 1% profitable trigger. Stop ratchets on each lot fill.</div>
              </div>
            </div>

            <h3 className={styles.rulesSectionTitle}>Backtest Performance</h3>

            <div className={styles.ruleCard} style={{ borderLeft: '3px solid #fcf000' }}>
              <div>
                <div className={styles.ruleName}>BL Backtest Results</div>
                <div className={styles.ruleDesc}>
                  1,660 BL trades | 67.2% win rate | +5.60% avg P&L | W/L ratio 3.50:1 | Positive every year including 2022.
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

            <h3 className={styles.rulesSectionTitle}>Kill Score — 8 Dimensions</h3>
            <div className={styles.ruleDesc} style={{ marginBottom: 10, color: '#888', fontSize: 12 }}>
              Formula: <strong style={{ color: '#fff' }}>Total = (D2 + D3 + D4 + D5 + D6 + D7 + D8) × D1</strong>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D1</div>
              <div>
                <div className={styles.ruleName}>Regime Multiplier (0.70–1.30×)</div>
                <div className={styles.ruleDesc}>Scales entire score by macro regime. SS: 1.0 − (regimeScore × 0.06) — bearish regime amplifies SS scores via intentional bias. This is where shorts get their edge.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D2</div>
              <div>
                <div className={styles.ruleName}>Sector Alignment (±15 pts, capped)</div>
                <div className={styles.ruleDesc}>5D component: |return5D%| × newMult × direction × 2 (new signals get 2×). 1M component: |return1M%| × direction. For SS, a deeply negative sector confirms the breakdown thesis. Capped ±15.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D3</div>
              <div>
                <div className={styles.ruleName}>Entry Quality (0–85 pts) — THE KEY DIMENSION</div>
                <div className={styles.ruleDesc}>Sub-A: Close conviction (cap 40 pts). Sub-B: EMA slope × 10, signal direction only (cap 30 pts). Sub-C: EMA separation bell curve — sweet spot 2-8% (up to 15 pts), decays 8-20%, 20%+ = OVEREXTENDED (score −99). Confirmation: ≥30=CONFIRMED, ≥15=PARTIAL, {'<'}15=UNCONFIRMED.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D4</div>
              <div>
                <div className={styles.ruleName}>Signal Freshness (−15 to +10 pts)</div>
                <div className={styles.ruleDesc}>New signals earn bonus scaled by D3 confirmation. Age 0 CONFIRMED: +10, PARTIAL: +6, UNCONFIRMED: +3. Decays to 0 by week 3–5, then −3/wk through week 9, smooth decay to floor −15.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D5</div>
              <div>
                <div className={styles.ruleName}>Rank Rise (±20 pts, capped)</div>
                <div className={styles.ruleDesc}>+1/-1 per position change in Kill rank week-over-week. For SS, a rising rank means the stock is weakening faster relative to peers. New entries start at 0. Capped ±20.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D6</div>
              <div>
                <div className={styles.ruleName}>Momentum (−10 to +20 pts)</div>
                <div className={styles.ruleDesc}>Sub-A RSI: ±5 pts (inverted for SS). Sub-B OBV week-over-week: ±5 pts (inverted for SS). Sub-C ADX: 0–5 pts when rising above 15. Sub-D Volume: +5 if ratio {'>'} 1.5×. Floor −10, cap +20.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D7</div>
              <div>
                <div className={styles.ruleName}>Rank Velocity (±10 pts)</div>
                <div className={styles.ruleDesc}>Acceleration of rank movement: velocity = currentRankChange − previousRankChange. Score = clip(round(velocity ÷ 6), −10, +10). Weakening faster than last week = positive for SS.</div>
              </div>
            </div>

            <div className={styles.ruleCard}>
              <div className={styles.ruleNum}>D8</div>
              <div>
                <div className={styles.ruleName}>Prey Presence (0–6 pts)</div>
                <div className={styles.ruleDesc}>SPRINT/HUNT +2 pts each. FEAST/ALPHA/SPRING/SNEAK +1 pt each. Maximum 6 pts. Acts as tiebreaker — most of the 679 universe scores 0 here.</div>
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
                <div className={styles.ruleName}>Lot 1 Entry + Pyramiding</div>
                <div className={styles.ruleDesc}>Same lot system as longs: Lot 1 at 35%, then Lots 2-5 with 5-day gate + 1% profitable trigger. Stop ratchets DOWN on each lot fill (only tightens for shorts).</div>
              </div>
            </div>

            <h3 className={styles.rulesSectionTitle}>Backtest Performance</h3>

            <div className={styles.ruleCard} style={{ borderLeft: '3px solid #fcf000' }}>
              <div>
                <div className={styles.ruleName}>SS Backtest Results</div>
                <div className={styles.ruleDesc}>
                  143 SS trades | 67.8% win rate | +4.20% avg P&L | W/L ratio 2.13:1 | No trades in 2021/2024 (bull regime — crash gate blocked all shorts by design).
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Backtest results popup ──────────────────────────────────────────────────

const BL_BACKTEST = {
  trades: 1660, winners: 1115, losers: 545,
  winRate: 67.2, avgPnl: 5.60, avgWin: 9.69, avgLoss: -2.77, wlRatio: 3.50,
  totalReturn: 9293,
  years: [
    { year: '2021', trades: 302, winPct: 67.5, avgPnl: 5.13 },
    { year: '2022', trades: 123, winPct: 69.1, avgPnl: 4.35 },
    { year: '2023', trades: 322, winPct: 61.8, avgPnl: 4.55 },
    { year: '2024', trades: 444, winPct: 67.8, avgPnl: 5.23 },
    { year: '2025', trades: 350, winPct: 70.3, avgPnl: 8.01 },
    { year: '2026', trades: 58, winPct: 62.1, avgPnl: 5.29 },
  ],
  exitReasons: [
    { reason: 'SIGNAL (BL exit)', count: 1423, winPct: 67.0, avgPnl: 5.58 },
    { reason: 'STOP HIT', count: 234, winPct: 68.4, avgPnl: 5.78 },
    { reason: 'STALE HUNT', count: 3, winPct: 0.0, avgPnl: -1.31 },
  ],
  topWinners: [
    { ticker: 'SNDK', entry: '2025-08-01', exit: '2025-11-07', pnl: 330.31 },
    { ticker: 'CELH', entry: '2024-07-19', exit: '2024-10-28', pnl: 84.88 },
    { ticker: 'ENPH', entry: '2023-01-06', exit: '2023-06-05', pnl: 83.81 },
    { ticker: 'SMCI', entry: '2023-10-27', exit: '2024-03-11', pnl: 73.06 },
    { ticker: 'WAT', entry: '2021-04-09', exit: '2021-08-03', pnl: 34.70 },
  ],
  topLosers: [
    { ticker: 'SMCI', entry: '2024-05-03', exit: '2024-05-09', pnl: -16.29 },
    { ticker: 'SEDG', entry: '2023-01-06', exit: '2023-02-23', pnl: -14.38 },
    { ticker: 'MOS', entry: '2022-06-03', exit: '2022-06-17', pnl: -13.88 },
    { ticker: 'DXYZ', entry: '2025-01-31', exit: '2025-02-24', pnl: -13.82 },
    { ticker: 'COIN', entry: '2024-03-08', exit: '2024-04-15', pnl: -13.42 },
  ],
};

const SS_BACKTEST = {
  trades: 143, winners: 97, losers: 46,
  winRate: 67.8, avgPnl: 4.20, avgWin: 7.97, avgLoss: -3.75, wlRatio: 2.13,
  totalReturn: 601,
  years: [
    { year: '2022', trades: 97, winPct: 68.0, avgPnl: 4.50 },
    { year: '2023', trades: 22, winPct: 72.7, avgPnl: 4.37 },
    { year: '2025', trades: 19, winPct: 78.9, avgPnl: 5.74 },
    { year: '2026', trades: 5, winPct: 40.0, avgPnl: -1.80 },
  ],
  noTradeYears: ['2021', '2024'],
  exitReasons: [
    { reason: 'SIGNAL (SS exit)', count: 120, winPct: 69.2, avgPnl: 4.53 },
    { reason: 'STOP HIT', count: 23, winPct: 60.9, avgPnl: 2.52 },
  ],
  topWinners: [
    { ticker: 'AMD', entry: '2022-09-09', exit: '2022-10-14', pnl: 33.44 },
    { ticker: 'FSLR', entry: '2022-04-08', exit: '2022-06-13', pnl: 31.82 },
    { ticker: 'ENPH', entry: '2022-12-16', exit: '2023-01-06', pnl: 26.15 },
    { ticker: 'MCHP', entry: '2025-03-28', exit: '2025-04-09', pnl: 20.60 },
    { ticker: 'NEE', entry: '2023-09-29', exit: '2023-10-23', pnl: 16.70 },
  ],
  topLosers: [
    { ticker: 'FSLR', entry: '2022-07-01', exit: '2022-07-25', pnl: -17.91 },
    { ticker: 'OXY', entry: '2022-06-17', exit: '2022-07-05', pnl: -15.05 },
    { ticker: 'ALB', entry: '2022-09-23', exit: '2022-10-04', pnl: -9.68 },
    { ticker: 'CCI', entry: '2023-10-20', exit: '2023-10-30', pnl: -5.39 },
    { ticker: 'BA', entry: '2023-10-20', exit: '2023-10-30', pnl: -4.23 },
  ],
};

function BacktestPopup({ type, onClose }) {
  const d = type === 'BL' ? BL_BACKTEST : SS_BACKTEST;
  const label = type === 'BL' ? 'BUY LONG' : 'SELL SHORT';
  const color = '#22c55e';
  const [trades, setTrades] = useState(null);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [showTrades, setShowTrades] = useState(false);

  function handleShowTrades() {
    if (trades) { setShowTrades(s => !s); return; }
    setLoadingTrades(true);
    fetchBacktestTrades(type)
      .then(data => { setTrades(data.trades || []); setShowTrades(true); })
      .catch(() => setTrades([]))
      .finally(() => setLoadingTrades(false));
  }

  return (
    <div className={styles.rulesOverlay} onClick={onClose}>
      <div className={`${styles.rulesPanel} ${showTrades ? styles.rulesPanelWide : ''}`} onClick={e => e.stopPropagation()}>
        <div className={styles.rulesHeader}>
          <h2 className={styles.rulesTitle}>{label} Backtest Results</h2>
          <button className={styles.rulesClose} onClick={onClose}>X</button>
        </div>

        <div className={styles.rulesBody}>
          <div className={styles.ruleDesc} style={{ color: '#888', marginBottom: 12 }}>
            5-year backtest (Apr 2021 – Apr 2026) · Filter-then-rank pipeline · Single lot per trade
          </div>

          {/* Headline stats */}
          <div className={styles.btStatsGrid}>
            <div className={styles.btStat}>
              <div className={styles.btStatValue} style={{ color }}>{d.trades}</div>
              <div className={styles.btStatLabel}>Trades</div>
            </div>
            <div className={styles.btStat}>
              <div className={styles.btStatValue} style={{ color }}>{d.winRate}%</div>
              <div className={styles.btStatLabel}>Win Rate</div>
            </div>
            <div className={styles.btStat}>
              <div className={styles.btStatValue} style={{ color }}>+{d.avgPnl}%</div>
              <div className={styles.btStatLabel}>Avg P&L</div>
            </div>
            <div className={styles.btStat}>
              <div className={styles.btStatValue} style={{ color }}>{d.wlRatio}:1</div>
              <div className={styles.btStatLabel}>W/L Ratio</div>
            </div>
            <div className={styles.btStat}>
              <div className={styles.btStatValue} style={{ color: '#22c55e' }}>+{d.avgWin}%</div>
              <div className={styles.btStatLabel}>Avg Winner</div>
            </div>
            <div className={styles.btStat}>
              <div className={styles.btStatValue} style={{ color: '#ef4444' }}>{d.avgLoss}%</div>
              <div className={styles.btStatLabel}>Avg Loser</div>
            </div>
          </div>

          {/* Year-by-year */}
          <h3 className={styles.rulesSectionTitle}>Year-by-Year Performance</h3>
          <table className={styles.btTable}>
            <thead>
              <tr>
                <th>Year</th>
                <th>Trades</th>
                <th>Win %</th>
                <th>Avg P&L</th>
              </tr>
            </thead>
            <tbody>
              {d.years.map(y => (
                <tr key={y.year}>
                  <td style={{ fontWeight: 700, color: '#fcf000' }}>{y.year}</td>
                  <td>{y.trades}</td>
                  <td style={{ color: y.winPct >= 60 ? '#22c55e' : y.winPct >= 50 ? '#eab308' : '#ef4444' }}>
                    {y.winPct}%
                  </td>
                  <td style={{ color: y.avgPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                    {y.avgPnl >= 0 ? '+' : ''}{y.avgPnl}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {type === 'SS' && d.noTradeYears && (
            <div className={styles.ruleDesc} style={{ marginTop: 6, color: '#888', fontSize: 11 }}>
              No SS trades in {d.noTradeYears.join(', ')} — bull regime, crash gate blocked all shorts (by design).
            </div>
          )}

          {/* By exit reason */}
          <h3 className={styles.rulesSectionTitle}>By Exit Reason</h3>
          <table className={styles.btTable}>
            <thead>
              <tr>
                <th>Reason</th>
                <th>Trades</th>
                <th>Win %</th>
                <th>Avg P&L</th>
              </tr>
            </thead>
            <tbody>
              {d.exitReasons.map(r => (
                <tr key={r.reason}>
                  <td>{r.reason}</td>
                  <td>{r.count}</td>
                  <td style={{ color: r.winPct >= 60 ? '#22c55e' : r.winPct >= 50 ? '#eab308' : '#ef4444' }}>
                    {r.winPct}%
                  </td>
                  <td style={{ color: r.avgPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                    {r.avgPnl >= 0 ? '+' : ''}{r.avgPnl}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Top winners */}
          <h3 className={styles.rulesSectionTitle}>Top 5 Winners</h3>
          <table className={styles.btTable}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>P&L</th>
              </tr>
            </thead>
            <tbody>
              {d.topWinners.map((t, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 700 }}>{t.ticker}</td>
                  <td>{t.entry}</td>
                  <td>{t.exit}</td>
                  <td style={{ color: '#22c55e', fontWeight: 700 }}>+{t.pnl.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Top losers */}
          <h3 className={styles.rulesSectionTitle}>Top 5 Losers</h3>
          <table className={styles.btTable}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>P&L</th>
              </tr>
            </thead>
            <tbody>
              {d.topLosers.map((t, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 700 }}>{t.ticker}</td>
                  <td>{t.entry}</td>
                  <td>{t.exit}</td>
                  <td style={{ color: '#ef4444', fontWeight: 700 }}>{t.pnl.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Total return */}
          <div className={styles.ruleCard} style={{ borderLeft: `3px solid ${color}`, marginTop: 16 }}>
            <div>
              <div className={styles.ruleName}>Total Cumulative Return (sum of all trade %)</div>
              <div className={styles.ruleDesc}>
                +{d.totalReturn.toLocaleString()}% across {d.trades} trades ({d.winners}W / {d.losers}L).
                {type === 'SS' && ' The strict crash gate ensures shorts only fire during genuine market breakdowns.'}
                {type === 'BL' && ' Positive every year including 2022 bear market.'}
              </div>
            </div>
          </div>

          {/* Individual trades toggle */}
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button className={styles.rulesBtn} onClick={handleShowTrades} disabled={loadingTrades}>
              {loadingTrades ? 'Loading...' : showTrades ? 'Hide Individual Trades' : `Show All ${d.trades} Trades`}
            </button>
          </div>

          {showTrades && trades && (
            <>
              <h3 className={styles.rulesSectionTitle}>
                All {label} Trades ({trades.length})
              </h3>
              <div className={styles.btTradesWrap}>
                <table className={styles.btTable}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Ticker</th>
                      <th>Entry Date</th>
                      <th>Entry $</th>
                      <th>Exit Date</th>
                      <th>Exit $</th>
                      <th>P&L %</th>
                      <th>Exit Reason</th>
                      <th>Sector</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => (
                      <tr key={i} className={t.isWinner ? styles.btTradeWin : styles.btTradeLoss}>
                        <td>{i + 1}</td>
                        <td style={{ fontWeight: 700 }}>{t.ticker}</td>
                        <td>{t.entryDate}</td>
                        <td>${t.entryPrice?.toFixed(2)}</td>
                        <td>{t.exitDate}</td>
                        <td>${t.exitPrice?.toFixed(2)}</td>
                        <td style={{ fontWeight: 700, color: t.profitPct >= 0 ? '#22c55e' : '#ef4444' }}>
                          {t.profitPct >= 0 ? '+' : ''}{t.profitPct?.toFixed(2)}%
                        </td>
                        <td style={{ fontSize: 11 }}>{t.exitReason}</td>
                        <td style={{ fontSize: 11 }}>{(t.sector || '').slice(0, 18)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OrdersPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('orders');
  const [rulesPopup, setRulesPopup] = useState(null);       // 'BL' | 'SS' | null
  const [backtestPopup, setBacktestPopup] = useState(null); // 'BL' | 'SS' | null
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
            <button className={`${styles.rulesBtn} ${styles.rulesBtnBT}`} onClick={() => setBacktestPopup('BL')}>BL Backtest Results</button>
            <button className={`${styles.rulesBtn} ${styles.rulesBtnSS}`} onClick={() => setRulesPopup('SS')}>SS Order Rules</button>
            <button className={`${styles.rulesBtn} ${styles.rulesBtnSSBT}`} onClick={() => setBacktestPopup('SS')}>SS Backtest Results</button>
          </div>
        </div>
      </div>

      {rulesPopup && <RulesPopup type={rulesPopup} onClose={() => setRulesPopup(null)} />}
      {backtestPopup && <BacktestPopup type={backtestPopup} onClose={() => setBacktestPopup(null)} />}

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
