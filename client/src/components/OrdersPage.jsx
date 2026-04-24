import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestOrders, fetchOrdersHistory, fetchOrdersGateLog, runOrdersManual, fetchBacktestTrades, fetchNav, API_BASE, authHeaders } from '../services/api';
import { sizePosition, isEtfTicker, calcHeat, STRIKE_PCT } from '../utils/sizingUtils.js';
import ChartModal from './ChartModal';
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

export function RulesPopup({ type, onClose }) {
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
                <div className={styles.ruleDesc}>Stock must have a confirmed Buy Long signal (close {'>'} sector EMA, slope up, high {'>='} 2-week high, 1-10% daylight above EMA)</div>
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
                  1,524 BL positions | 66.7% win rate | +5.27% avg P&L | W/L ratio 3.74:1 | CAGR +36.8% | Sharpe 3.50 | Max DD -0.74% | Pyramiding (Lots 1-5, $10K full position) | Positive every year including 2022.
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
                <div className={styles.ruleDesc}>Stock must have a confirmed Sell Short signal (close {'<'} sector EMA, slope down, low {'<='} 2-week low, 1-10% below EMA)</div>
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
                  143 SS positions | 62.2% win rate | +3.59% avg P&L | W/L ratio 2.60:1 | CAGR +15.3% | Sharpe 2.02 | Max DD -0.61% | Pyramiding (Lots 1-5, $10K full position) | No trades in 2021/2024 (bull regime — crash gate blocked all shorts by design).
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

// ── Pyramid strategy (35/25/20/12/8% lots, full D1-D8 scoring, Jun 2019–Apr 2026) ──
// Win rate lower than single-lot because stop ratchets move to avg cost on lot fills,
// converting small single-lot winners (e.g. +1–2%) into losses when price retraces
// to the now-higher avg cost. W/L ratio improves: fewer small wins, bigger winners.
const BL_BACKTEST = {
  trades: 2363, winners: 1172, losers: 1191,
  winRate: 49.6, avgPnl: 2.55, avgWin: 7.07, avgLoss: -1.90, wlRatio: 3.72,
  totalReturn: 747076,
  lotRows: 2363,
  avgLots: 2.76,
  lotDist: { 1: '29.3%', 2: '23.7%', 3: '11.9%', 4: '11.4%', 5: '23.8%' },
  years: [
    { year: '2019', trades: 238, winPct: 47.9, avgPnl: 1.39 },
    { year: '2020', trades: 379, winPct: 47.0, avgPnl: 1.88 },
    { year: '2021', trades: 437, winPct: 48.7, avgPnl: 2.38 },
    { year: '2022', trades: 149, winPct: 52.3, avgPnl: 1.20 },
    { year: '2023', trades: 292, winPct: 43.2, avgPnl: 1.74 },
    { year: '2024', trades: 451, winPct: 55.0, avgPnl: 3.15 },
    { year: '2025', trades: 331, winPct: 49.8, avgPnl: 4.26 },
    { year: '2026', trades: 86,  winPct: 58.1, avgPnl: 4.89 },
  ],
  exitReasons: [
    { reason: 'SIGNAL (BL exit)', count: 1639, winPct: 60.9, avgPnl: 3.26 },
    { reason: 'STOP HIT', count: 716, winPct: 24.3, avgPnl: 0.96 },
    { reason: 'STALE HUNT', count: 8, winPct: 0.0, avgPnl: -1.04 },
  ],
  topWinners: [
    { ticker: 'SNDK', entry: '2025-08-29', exit: '2025-11-17', pnl: 330.31 },
    { ticker: 'HOOD', entry: '2025-05-02', exit: '2025-07-28', pnl: 94.30 },
    { ticker: 'CIEN', entry: '2025-08-29', exit: '2025-11-17', pnl: 81.35 },
    { ticker: 'GEV',  entry: '2024-08-30', exit: '2024-12-09', pnl: 71.18 },
    { ticker: 'MUX',  entry: '2025-08-22', exit: '2025-10-27', pnl: 68.22 },
  ],
  topLosers: [
    { ticker: 'SMCI', entry: '2024-05-24', exit: '2024-05-28', pnl: -16.29 },
    { ticker: 'UBER', entry: '2022-08-12', exit: '2022-08-22', pnl: -12.32 },
    { ticker: 'AA',   entry: '2021-11-12', exit: '2021-11-29', pnl: -12.14 },
    { ticker: 'ANET', entry: '2025-10-31', exit: '2025-11-03', pnl: -12.05 },
    { ticker: 'FSLR', entry: '2021-01-29', exit: '2021-02-01', pnl: -10.98 },
  ],
};

const SS_BACKTEST = {
  trades: 147, winners: 71, losers: 76,
  winRate: 48.3, avgPnl: 1.94, avgWin: 6.38, avgLoss: -2.20, wlRatio: 2.89,
  totalReturn: 34614,
  lotRows: 147,
  avgLots: 2.77,
  lotDist: { 1: '29.2%', 2: '23.7%', 3: '11.8%', 4: '11.5%', 5: '23.8%' },
  years: [
    { year: '2022', trades: 100, winPct: 49.0, avgPnl: 2.21 },
    { year: '2023', trades: 22,  winPct: 45.5, avgPnl: 1.37 },
    { year: '2025', trades: 20,  winPct: 50.0, avgPnl: 2.64 },
    { year: '2026', trades: 5,   winPct: 40.0, avgPnl: -0.91 },
  ],
  noTradeYears: ['2019', '2020', '2021', '2024'],
  exitReasons: [
    { reason: 'SIGNAL (SS exit)', count: 120, winPct: 69.2, avgPnl: 4.53 },
    { reason: 'STOP HIT',         count: 23,  winPct: 60.9, avgPnl: 2.50 },
  ],
  topWinners: [
    { ticker: 'AMD',  entry: '2022-09-16', exit: '2022-10-24', pnl: 33.44 },
    { ticker: 'STX',  entry: '2022-09-02', exit: '2022-10-24', pnl: 26.28 },
    { ticker: 'TROW', entry: '2022-01-21', exit: '2022-03-14', pnl: 22.46 },
    { ticker: 'ARE',  entry: '2022-05-06', exit: '2022-06-27', pnl: 20.70 },
    { ticker: 'MCHP', entry: '2025-03-28', exit: '2025-04-09', pnl: 20.60 },
  ],
  topLosers: [
    { ticker: 'FSLR', entry: '2022-07-15', exit: '2022-07-18', pnl: -17.91 },
    { ticker: 'ASML', entry: '2022-03-11', exit: '2022-03-14', pnl: -12.58 },
    { ticker: 'ADBE', entry: '2022-11-04', exit: '2022-11-07', pnl: -11.17 },
    { ticker: 'AMD',  entry: '2022-03-11', exit: '2022-03-21', pnl: -10.72 },
    { ticker: 'ASML', entry: '2022-04-15', exit: '2022-04-20', pnl: -6.77 },
  ],
};

// ── Hedge Fund Metrics — v21 canonical Wagyu ($1M tier) Gross, Jun 2019 -> Apr 2026 (6.85 years) ──
// COMBINED uses Gross MTM daily NAV curve (pre-fund-fee, post-transaction-cost); matches published
// Wagyu Gross (Sharpe 2.59 / Sortino 4.72 / MaxDD -8.51%). BL_HEDGE / SS_HEDGE are realized-Gross
// per-direction breakouts from pnthr_bt_pyramid_nav_1m_trade_log (fees are portfolio-level per
// PPM Sec. 4.1-4.3 and do not cleanly decompose by direction).
// Source: scripts_den/compute_per_direction_metrics.js run on 2026-04-21.

const BL_HEDGE = {
  // BL-only realized Gross from v21 Wagyu trade log (2,457 trades)
  cagr: 37.97, sharpe: 3.19, sortino: 85.06,
  maxDrawdown: 0.91, maxDDPeriod: '2019-09 to 2019-10',
  calmar: 41.74, profitFactor: 10.33,
  winRate: 51.2,   // BL wins 1257 / (1257 + 1200) trade-level
  bestMonth: 12.56, bestMonthLabel: '2021-01',
  worstMonth: -0.85, worstMonthLabel: '2019-10',
  positiveMonths: 69, totalMonths: 83,
  positiveMonthsPct: 83.1,
  avgMonthlyReturn: 2.47, monthlyStdDev: 2.82,
};

const SS_HEDGE = {
  // SS-only realized Gross from v21 Wagyu trade log (157 trades; SS Crash Gate restrictive)
  cagr: 4.98, sharpe: 0.49, sortino: 24.66,
  maxDrawdown: 0.65, maxDDPeriod: '2022-04 to 2022-05',
  calmar: 7.64, profitFactor: 7.43,
  winRate: 48.4,   // SS wins 76 / (76 + 81) trade-level
  bestMonth: 8.72, bestMonthLabel: '2022-05',
  worstMonth: -0.24, worstMonthLabel: '2026-03',
  positiveMonths: 14, totalMonths: 83,
  positiveMonthsPct: 16.9,
  avgMonthlyReturn: 0.40, monthlyStdDev: 1.48,
};

const COMBINED_HEDGE = {
  // Combined Wagyu Gross MTM daily NAV — Jun 2019 -> Apr 2026 (83 months, 2,614 closed trades)
  // $1M -> $9.37M on Gross MTM basis at Wagyu tier
  cagr: 38.60, sharpe: 2.56, sortino: 4.72,
  maxDrawdown: 8.51, maxDDPeriod: '2020-09 to 2020-09',
  calmar: 4.54, profitFactor: 10.14,
  bestMonth: 17.36, bestMonthLabel: '2019-11',
  worstMonth: -4.64, worstMonthLabel: '2020-09',
  positiveMonths: 69, totalMonths: 83,
  positiveMonthsPct: 83.1,
  avgMonthlyReturn: 2.60, monthlyStdDev: 3.14,
};

// ── Institutional Metrics Section (shared by BacktestPopup + PortfolioPopup) ──

function HedgeFundSection({ h, label }) {
  const gold = '#fcf000';
  return (
    <>
      <h3 className={styles.rulesSectionTitle}>Institutional Metrics — {label}</h3>
      <div className={styles.ruleDesc} style={{ color: '#888', marginBottom: 10, fontSize: 11 }}>
        $100K starting capital · $10K full position (Lots 1-5) · Annualized from monthly returns · Risk-free rate 5%
      </div>
      <div className={styles.btStatsGrid}>
        <div className={styles.btStat}>
          <div className={styles.btStatValue} style={{ color: gold }}>+{h.cagr}%</div>
          <div className={styles.btStatLabel} style={{ color: '#22c55e' }}>CAGR</div>
          <div className={styles.btStatLabel} style={{ color: '#22c55e', fontSize: 10, marginTop: 2 }}>(Compound Annual Growth Rate)</div>
        </div>
        <div className={styles.btStat}>
          <div className={styles.btStatValue} style={{ color: gold }}>{h.sharpe}</div>
          <div className={styles.btStatLabel}>Sharpe Ratio</div>
        </div>
        <div className={styles.btStat}>
          <div className={styles.btStatValue} style={{ color: gold }}>{h.sortino}</div>
          <div className={styles.btStatLabel}>Sortino Ratio</div>
        </div>
        <div className={styles.btStat}>
          <div className={styles.btStatValue} style={{ color: '#ef4444' }}>-{h.maxDrawdown}%</div>
          <div className={styles.btStatLabel}>Max Drawdown</div>
        </div>
        <div className={styles.btStat}>
          <div className={styles.btStatValue} style={{ color: gold }}>{h.calmar}</div>
          <div className={styles.btStatLabel}>Calmar Ratio</div>
        </div>
        <div className={styles.btStat}>
          <div className={styles.btStatValue} style={{ color: gold }}>{h.profitFactor}</div>
          <div className={styles.btStatLabel}>Profit Factor</div>
        </div>
      </div>
      <table className={styles.btTable}>
        <tbody>
          <tr><td style={{ color: '#888' }}>Max DD Period</td><td>{h.maxDDPeriod}</td></tr>
          <tr><td style={{ color: '#888' }}>Best Month</td><td style={{ color: '#22c55e' }}>+{h.bestMonth}% ({h.bestMonthLabel})</td></tr>
          <tr><td style={{ color: '#888' }}>Worst Month</td><td style={{ color: '#ef4444' }}>{h.worstMonth}% ({h.worstMonthLabel})</td></tr>
          <tr><td style={{ color: '#888' }}>Positive Months</td><td>{h.positiveMonths}/{h.totalMonths} ({h.positiveMonthsPct}%)</td></tr>
          <tr><td style={{ color: '#888' }}>Avg Monthly Return</td><td style={{ color: '#22c55e' }}>+{h.avgMonthlyReturn}%</td></tr>
          <tr><td style={{ color: '#888' }}>Monthly Std Dev</td><td>{h.monthlyStdDev}%</td></tr>
        </tbody>
      </table>
    </>
  );
}

// ── PNTHR Institutional Metrics popup ───────────────────────────────────────

export function InstitutionalPopup({ onClose }) {
  const gold = '#fcf000';
  const green = '#22c55e';
  const red = '#ef4444';
  const dim = '#888';

  return (
    <div className={styles.rulesOverlay} onClick={onClose}>
      <div className={styles.rulesPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.rulesHeader}>
          <h2 className={styles.rulesTitle}>PNTHR Institutional Metrics</h2>
          <button className={styles.rulesClose} onClick={onClose}>X</button>
        </div>
        <div className={styles.rulesBody}>
          <div className={styles.ruleDesc} style={{ color: dim, marginBottom: 16 }}>
            7-year backtest (Jun 2019 – Apr 2026) · $100K starting capital · $10K full position (Lots 1-5) · Risk-free rate 5%
          </div>

          {/* Table 1: PNTHR BL vs SS vs Combined */}
          <h3 className={styles.rulesSectionTitle}>PNTHR Performance Breakdown</h3>
          <table className={styles.btTable}>
            <thead>
              <tr>
                <th>Metric</th>
                <th style={{ textAlign: 'right' }}>BL (Longs)</th>
                <th style={{ textAlign: 'right' }}>SS (Shorts)</th>
                <th style={{ textAlign: 'right' }}>Combined</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ color: dim }}>CAGR</td>
                <td style={{ textAlign: 'right', color: green, fontWeight: 700 }}>+{BL_HEDGE.cagr}%</td>
                <td style={{ textAlign: 'right', color: green, fontWeight: 700 }}>+{SS_HEDGE.cagr}%</td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>+{COMBINED_HEDGE.cagr}%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Sharpe Ratio</td>
                <td style={{ textAlign: 'right' }}>{BL_HEDGE.sharpe}</td>
                <td style={{ textAlign: 'right' }}>{SS_HEDGE.sharpe}</td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>{COMBINED_HEDGE.sharpe}</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Sortino Ratio</td>
                <td style={{ textAlign: 'right' }}>{BL_HEDGE.sortino}</td>
                <td style={{ textAlign: 'right' }}>{SS_HEDGE.sortino}</td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>{COMBINED_HEDGE.sortino}</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Max Drawdown</td>
                <td style={{ textAlign: 'right', color: red }}>-{BL_HEDGE.maxDrawdown}%</td>
                <td style={{ textAlign: 'right', color: red }}>-{SS_HEDGE.maxDrawdown}%</td>
                <td style={{ textAlign: 'right', color: red }}>-{COMBINED_HEDGE.maxDrawdown}%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Calmar Ratio</td>
                <td style={{ textAlign: 'right' }}>{BL_HEDGE.calmar}</td>
                <td style={{ textAlign: 'right' }}>{SS_HEDGE.calmar}</td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>{COMBINED_HEDGE.calmar}</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Profit Factor</td>
                <td style={{ textAlign: 'right' }}>{BL_HEDGE.profitFactor}</td>
                <td style={{ textAlign: 'right' }}>{SS_HEDGE.profitFactor}</td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>{COMBINED_HEDGE.profitFactor}</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Win Rate</td>
                <td style={{ textAlign: 'right' }}>{BL_HEDGE.winRate}%</td>
                <td style={{ textAlign: 'right' }}>{SS_HEDGE.winRate}%</td>
                <td style={{ textAlign: 'right' }}>49.5%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Avg Monthly Return</td>
                <td style={{ textAlign: 'right', color: green }}>+{BL_HEDGE.avgMonthlyReturn}%</td>
                <td style={{ textAlign: 'right', color: green }}>+{SS_HEDGE.avgMonthlyReturn}%</td>
                <td style={{ textAlign: 'right', color: green }}>+{COMBINED_HEDGE.avgMonthlyReturn}%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Monthly Std Dev</td>
                <td style={{ textAlign: 'right' }}>{BL_HEDGE.monthlyStdDev}%</td>
                <td style={{ textAlign: 'right' }}>{SS_HEDGE.monthlyStdDev}%</td>
                <td style={{ textAlign: 'right' }}>{COMBINED_HEDGE.monthlyStdDev}%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Best Month</td>
                <td style={{ textAlign: 'right', color: green }}>+{BL_HEDGE.bestMonth}%</td>
                <td style={{ textAlign: 'right', color: green }}>+{SS_HEDGE.bestMonth}%</td>
                <td style={{ textAlign: 'right', color: green }}>+{COMBINED_HEDGE.bestMonth}%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Worst Month</td>
                <td style={{ textAlign: 'right', color: red }}>{BL_HEDGE.worstMonth}%</td>
                <td style={{ textAlign: 'right', color: red }}>{SS_HEDGE.worstMonth}%</td>
                <td style={{ textAlign: 'right', color: red }}>{COMBINED_HEDGE.worstMonth}%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Positive Months</td>
                <td style={{ textAlign: 'right' }}>{BL_HEDGE.positiveMonths}/{BL_HEDGE.totalMonths} ({BL_HEDGE.positiveMonthsPct}%)</td>
                <td style={{ textAlign: 'right' }}>{SS_HEDGE.positiveMonths}/{SS_HEDGE.totalMonths} ({SS_HEDGE.positiveMonthsPct}%)</td>
                <td style={{ textAlign: 'right' }}>{COMBINED_HEDGE.positiveMonths}/{COMBINED_HEDGE.totalMonths} ({COMBINED_HEDGE.positiveMonthsPct}%)</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Total Trades</td>
                <td style={{ textAlign: 'right' }}>{BL_BACKTEST.trades.toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{SS_BACKTEST.trades}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{(BL_BACKTEST.trades + SS_BACKTEST.trades).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          {/* Table 2: PNTHR vs S&P 500 */}
          <h3 className={styles.rulesSectionTitle} style={{ marginTop: 20 }}>PNTHR vs S&P 500</h3>
          <table className={styles.btTable}>
            <thead>
              <tr>
                <th>Metric</th>
                <th style={{ textAlign: 'right' }}>PNTHR Combined</th>
                <th style={{ textAlign: 'right' }}>S&P 500 (approx)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ color: dim }}>CAGR <span style={{ fontSize: 11, fontWeight: 400 }}>(Compound Annual Growth Rate)</span></td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>+{COMBINED_HEDGE.cagr}%</td>
                <td style={{ textAlign: 'right' }}>~10-12%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Sharpe Ratio</td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>{COMBINED_HEDGE.sharpe}</td>
                <td style={{ textAlign: 'right' }}>~0.5-0.8</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Sortino Ratio</td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>{COMBINED_HEDGE.sortino}</td>
                <td style={{ textAlign: 'right' }}>~0.7-1.0</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Max Drawdown</td>
                <td style={{ textAlign: 'right', color: green }}>-{COMBINED_HEDGE.maxDrawdown}%</td>
                <td style={{ textAlign: 'right', color: red }}>~-25%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Positive Months</td>
                <td style={{ textAlign: 'right', color: gold, fontWeight: 700 }}>{COMBINED_HEDGE.positiveMonthsPct}%</td>
                <td style={{ textAlign: 'right' }}>~60-65%</td>
              </tr>
              <tr>
                <td style={{ color: dim }}>Worst Month</td>
                <td style={{ textAlign: 'right', color: green }}>{COMBINED_HEDGE.worstMonth}%</td>
                <td style={{ textAlign: 'right', color: red }}>~-9%</td>
              </tr>
            </tbody>
          </table>

          <div className={styles.ruleCard} style={{ borderLeft: `3px solid ${gold}`, marginTop: 16 }}>
            <div>
              <div className={styles.ruleName}>Interpretation</div>
              <div className={styles.ruleDesc}>
                PNTHR Funds proprietary signal implementation system's results are world class. Sharpe {'>'} 2.0 is exceptional. Top hedge funds target 1.0-1.5. Max drawdown of -0.24% vs the S&P's -25% in 2022 demonstrates extreme capital protection. Pyramiding concentrates capital into winners while losers stay small (Lot 1 only). 95% positive months with a worst month of just -0.24% is institutional-grade consistency. CAGR assumes $10K full position sizing. Actual returns scale with account size and risk allocation.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BacktestPopup({ type, onClose }) {
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
            7-year backtest (Jun 2019 – Apr 2026) · Filter-then-rank pipeline · Pyramiding (Lots 1-5) · $10K full position
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
              <div className={styles.ruleName}>Total Dollar P&L ($10K full position per trade)</div>
              <div className={styles.ruleDesc}>
                ${d.totalReturn.toLocaleString()} across {d.trades} positions ({d.winners}W / {d.losers}L) · Avg {d.avgLots} lots/trade · CAGR +{type === 'BL' ? BL_HEDGE.cagr : SS_HEDGE.cagr}%
                {type === 'SS' && ' · The strict crash gate ensures shorts only fire during genuine market breakdowns.'}
                {type === 'BL' && ' · Positive every year including 2022 bear market.'}
              </div>
            </div>
          </div>

          {/* Institutional Metrics */}
          <HedgeFundSection h={type === 'BL' ? BL_HEDGE : SS_HEDGE} label={label} />

          {/* Individual trades toggle */}
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button className={styles.rulesBtn} onClick={handleShowTrades} disabled={loadingTrades}>
              {loadingTrades ? 'Loading...' : showTrades ? 'Hide Individual Trades' : `Show All ${d.lotRows} Lot Entries`}
            </button>
          </div>

          {showTrades && trades && (
            <>
              <h3 className={styles.rulesSectionTitle}>
                All {label} Lot Entries ({trades.length})
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
                      <th>Lot</th>
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
                        <td style={{ fontSize: 11, color: t.lotNum > 1 ? '#fcf000' : '#888', whiteSpace: 'nowrap' }}>
                          Lot {t.lotNum}, {Math.round((t.lotPct || 0) * 100)}%
                        </td>
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
  const [institutionalPopup, setInstitutionalPopup] = useState(false);
  const [gateData, setGateData] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [nav, setNav] = useState(100000);
  const [chartIndex, setChartIndex] = useState(null);
  const [openPositions, setOpenPositions] = useState([]); // currently-open portfolio — drives stock-cap clamp

  useEffect(() => {
    fetchNav().then(r => { if (r?.nav) setNav(r.nav); }).catch(() => {});
    // Open positions feed the stock-heat cap calculation. Ignore failure —
    // worst case the cap reads as "full budget" and nothing gets clamped.
    // /api/positions returns this user's currently-open Command Center
    // positions (status !== CLOSED), which is exactly what calcHeat expects.
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/positions`, { headers: authHeaders() });
        if (!res.ok) return;
        const list = await res.json();
        if (Array.isArray(list)) setOpenPositions(list);
      } catch { /* non-fatal */ }
    })();
  }, []);

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

  // ── Stock-heat cap clamp ──────────────────────────────────────────────────
  // The backtest/Orders sizer computes IDEAL per-position shares in isolation.
  // In live trading the 10%-of-NAV stock-risk cap is a portfolio-wide ceiling,
  // so if current filled positions are already using, say, $6,758 of an
  // $8,500 budget, only $1,742 is available for new fills.
  //
  // We walk the orders in Kill-score order (strongest first) and clamp each
  // row's Lot 1 size to whatever risk budget remains. Later rows shrink or
  // go to zero as the budget is exhausted. ETFs are skipped (don't count
  // against the stock cap, don't consume it either).
  //
  // NOTE: this hook MUST live above the early `loading/error/!data` returns
  // so React sees a stable hook count across renders. data may still be null
  // on the first pass, so we null-guard the inputs.
  const { clampedOrders, capBudget, capUsed, capLeftAfter } = useMemo(() => {
    const rawOrders = data?.orders || [];
    const heat      = calcHeat(openPositions || [], nav);
    const budget    = nav * 0.10;                 // 10% stock-risk cap in $
    const used      = heat.stockRisk || 0;        // currently-filled stock risk $
    let capLeft     = Math.max(0, budget - used); // $ remaining before cap

    // Sort a COPY of orders by Kill score DESC so clamping follows rank,
    // but the returned list preserves original per-ticker identity.
    const rankMap = new Map();
    const byScore = [...rawOrders].sort((a, b) => (b.killScore ?? 0) - (a.killScore ?? 0));

    for (const o of byScore) {
      const entry = o.signalPrice || o.currentPrice || 0;
      const stop  = o.stopPrice || 0;
      const rps   = Math.abs(entry - stop);
      const sized = (entry > 0 && stop > 0 && nav > 0)
        ? sizePosition({
            netLiquidity: nav,
            entryPrice:   entry,
            stopPrice:    stop,
            maxGapPct:    o.maxGapPct || 0,
            direction:    o.direction || (o.signal === 'BL' ? 'LONG' : 'SHORT'),
            isETF:        isEtfTicker(o.ticker),
          })
        : null;
      const totalShares = sized?.totalShares || 0;
      // Lot 1 = 35% of full pyramid size. Floor (not round) so the integer
      // share count never implies more risk than the dollars would pay for.
      const idealLot1 = totalShares > 0 ? Math.max(1, Math.floor(totalShares * STRIKE_PCT[0])) : 0;

      let cappedLot1 = idealLot1;
      let clamped    = false;

      if (!isEtfTicker(o.ticker) && rps > 0 && idealLot1 > 0) {
        const idealRisk = idealLot1 * rps;
        if (idealRisk > capLeft) {
          cappedLot1 = Math.max(0, Math.floor(capLeft / rps));
          clamped    = true;
        }
        capLeft = Math.max(0, capLeft - cappedLot1 * rps);
      }

      rankMap.set(o.ticker, {
        idealLot1,
        cappedLot1,
        clampedByStockCap: clamped,
        lot1Risk$: cappedLot1 * rps,
      });
    }

    const enriched = rawOrders.map(o => ({ ...o, ...(rankMap.get(o.ticker) || {}) }));
    return {
      clampedOrders: enriched,
      capBudget:     budget,
      capUsed:       used,
      capLeftAfter:  capLeft, // after hypothetically filling every Order lot 1
    };
  }, [data, openPositions, nav]);

  if (loading) return <div className={styles.loading}>Loading orders...</div>;
  if (error) return <div className={styles.error}>Error: {error}</div>;
  if (!data) return <div className={styles.empty}><p className={styles.emptyTitle}>No order data</p></div>;

  const { regime, mode, orders, stats, sectorSummary, dailyUpdates, type: docType, generatedAt } = data;

  const gtdExp = nextFriday();

  const blOrders = clampedOrders.filter(o => o.signal === 'BL');
  const ssOrders = clampedOrders.filter(o => o.signal === 'SS');
  const capLeftBefore = Math.max(0, capBudget - capUsed);

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
            <button className={`${styles.rulesBtn} ${styles.rulesBtnInstitutional}`} onClick={() => setInstitutionalPopup(true)}>PNTHR Institutional Metrics</button>
          </div>
        </div>
      </div>

      {rulesPopup && <RulesPopup type={rulesPopup} onClose={() => setRulesPopup(null)} />}
      {backtestPopup && <BacktestPopup type={backtestPopup} onClose={() => setBacktestPopup(null)} />}
      {institutionalPopup && <InstitutionalPopup onClose={() => setInstitutionalPopup(false)} />}

      {/* Admin controls */}
      {isAdmin && (
        <div className={styles.adminBar}>
          <button className={styles.adminBtn} disabled={running} onClick={() => handleManualRun('WEEKLY')}>
            <span>{running ? 'Running...' : 'Run PREVIEW'}</span>
            <span className={styles.adminBtnSub}>(Run Friday 11am AZ)</span>
          </button>
          <button className={styles.adminBtn} disabled={running} onClick={() => handleManualRun('CONFIRMED')}>
            <span>{running ? 'Running...' : 'Run CONFIRMED'}</span>
            <span className={styles.adminBtnSub}>(Run after 1:15pm AZ)</span>
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
              {/* Stock-heat capacity banner — what's left in the 10% cap after
                  existing open positions, and what would remain if every Lot 1
                  on this sheet were filled at the clamped sizes. */}
              <CapacityBanner
                budget={capBudget}
                used={capUsed}
                leftBefore={capLeftBefore}
                leftAfter={capLeftAfter}
              />

              {/* BL Orders */}
              {blOrders.length > 0 && (
                <div className={styles.gateSection}>
                  <h3 className={styles.gateSectionTitle}>BUY LONG ({blOrders.length})</h3>
                  <OrderTable orders={blOrders} gtdExp={gtdExp} nav={nav}
                    onTickerClick={(t) => setChartIndex(orders.findIndex(o => o.ticker === t))} />
                </div>
              )}

              {/* SS Orders */}
              {ssOrders.length > 0 && (
                <div className={styles.gateSection}>
                  <h3 className={styles.gateSectionTitle}>SELL SHORT ({ssOrders.length})</h3>
                  <OrderTable orders={ssOrders} gtdExp={gtdExp} nav={nav}
                    onTickerClick={(t) => setChartIndex(orders.findIndex(o => o.ticker === t))} />
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

      {/* Chart modal — opens on ticker click */}
      {chartIndex != null && chartIndex >= 0 && (
        <ChartModal
          stocks={orders}
          initialIndex={chartIndex}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}

// ── Order table sub-component ──────────────────────────────────────────────────

// Stock-heat capacity banner — shows the 10% stock-risk budget, how much of
// it the currently-open portfolio is consuming, how much is left, and what
// would remain if every clamped Lot 1 on this sheet filled at the sizes the
// table is recommending.
function CapacityBanner({ budget, used, leftBefore, leftAfter }) {
  if (!budget || budget <= 0) return null;
  const pctUsed   = Math.min(100, (used / budget) * 100);
  const pctLeft   = Math.max(0, 100 - pctUsed);
  const willUse   = Math.max(0, leftBefore - leftAfter);
  const afterPct  = Math.max(0, ((leftAfter) / budget) * 100);
  const color     = pctUsed >= 95 ? '#dc3545'
                  : pctUsed >= 80 ? '#ffc107'
                  :                 '#22c55e';
  const fmt = (n) => `$${Math.round(n).toLocaleString()}`;
  return (
    <div style={{
      display:     'flex',
      flexWrap:    'wrap',
      alignItems:  'center',
      gap:         14,
      padding:     '8px 14px',
      marginBottom: 10,
      background:  '#0e0e0e',
      border:      '1px solid #222',
      borderLeft:  `3px solid ${color}`,
      borderRadius: 6,
      fontSize:    12,
      color:       '#ccc',
      fontVariantNumeric: 'tabular-nums',
    }}>
      <span style={{ color: '#888', letterSpacing: '0.05em', fontWeight: 700 }}>
        STOCK HEAT CAP (10%)
      </span>
      <span>budget <b style={{ color: '#fcf000' }}>{fmt(budget)}</b></span>
      <span>in use <b style={{ color }}>{fmt(used)}</b> ({pctUsed.toFixed(1)}%)</span>
      <span>left <b style={{ color: leftBefore > 0 ? '#22c55e' : '#dc3545' }}>{fmt(leftBefore)}</b> ({pctLeft.toFixed(1)}%)</span>
      <span style={{ opacity: 0.75 }}>
        if all Lot 1 fills → <b>{fmt(willUse)}</b> added, <b>{fmt(leftAfter)}</b> remaining ({afterPct.toFixed(1)}%)
      </span>
    </div>
  );
}

function OrderTable({ orders, gtdExp, nav, onTickerClick }) {
  return (
    <table className={styles.ordersTable}>
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Action</th>
          <th>Lot 1 Shares</th>
          <th>Entry (Limit)</th>
          <th>Stop</th>
          <th>GTD Expiry</th>
          <th>Sector</th>
          <th>RSI</th>
          <th>#</th>
          <th>Kill Score</th>
          <th>Tier</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o, i) => {
          const entry = o.signalPrice || o.currentPrice || 0;
          // Lot 1 figures are pre-clamped against the 10% stock-cap by
          // OrdersPage; fall back to ideal if a row came in without the
          // enrichment (defensive — shouldn't happen in normal flow).
          const ideal  = o.idealLot1  ?? 0;
          const shares = o.cappedLot1 ?? ideal;
          const clamped = !!o.clampedByStockCap;
          const cost    = shares * entry;
          // Earnings-this-week rows get the same yellow treatment as PreyPage.
          // Wash-sale-blocked tickers get a small red WASH badge next to the ticker.
          const rowBg = o.hasEarningsThisWeek ? '#fef3c7' : undefined;
          const rowColor = o.hasEarningsThisWeek ? '#1a1a1a' : undefined;
          return (
            <tr key={o.ticker} style={rowBg ? { background: rowBg, color: rowColor } : undefined}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <strong
                    onClick={() => onTickerClick?.(o.ticker)}
                    style={{
                      cursor: onTickerClick ? 'pointer' : 'default',
                      color: o.hasEarningsThisWeek ? '#1a1a1a' : '#fcf000',
                      textDecoration: 'underline dotted',
                    }}
                    title="Click to view chart"
                  >
                    {o.ticker}
                  </strong>
                  {o.washBlocked && (
                    <span
                      title={`Wash sale window open until ${o.washExpiryDate ? new Date(o.washExpiryDate).toLocaleDateString() : 'unknown'} — trading this will disallow the loss`}
                      style={{
                        background: '#dc3545', color: '#fff',
                        fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
                        padding: '1px 6px', borderRadius: 3,
                      }}
                    >WASH</span>
                  )}
                  {o.hasEarningsThisWeek && (
                    <span
                      title={`Earnings on ${o.nextEarningsDate || 'this week'}`}
                      style={{
                        background: '#b45309', color: '#fff',
                        fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
                        padding: '1px 6px', borderRadius: 3,
                      }}
                    >EARNINGS</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: o.hasEarningsThisWeek ? '#555' : '#888' }}>{o.companyName}</div>
              </td>
              <td>
                <span className={o.signal === 'BL' ? styles.dirBL : styles.dirSS}>
                  {o.signal === 'BL' ? 'BUY' : 'SHORT'}
                </span>
              </td>
              <td style={{ fontFamily: 'monospace' }}>
                {/* Lot 1 share count. If the 10%-stock-cap clamp reduced the
                    number, show the ideal struck-through in red alongside the
                    capped value in green so the trader sees both. */}
                {ideal > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    {clamped && (
                      <span
                        title="Ideal Lot 1 size before clamping to 10% stock-heat cap"
                        style={{ color: '#dc3545', textDecoration: 'line-through', fontSize: 12 }}
                      >
                        {ideal.toLocaleString()}
                      </span>
                    )}
                    <span
                      title={clamped
                        ? `Capped to ${shares} shr (${ideal - shares} trimmed) so the new fills stay within the 10% stock-heat budget.`
                        : `Full Lot 1 fits within remaining 10% stock-heat budget.`}
                      style={{
                        color: clamped
                          ? (shares === 0 ? '#dc3545' : '#22c55e')
                          : '#fcf000',
                        fontWeight: clamped ? 700 : 400,
                      }}
                    >
                      {shares.toLocaleString()}
                    </span>
                  </div>
                ) : (
                  <span style={{ color: '#666' }}>—</span>
                )}
                {shares > 0 && (
                  <div style={{ fontSize: 10, color: '#888' }}>
                    ${Math.round(cost).toLocaleString()}
                  </div>
                )}
              </td>
              <td className={styles.entryPrice}>${o.signalPrice?.toFixed(2) || o.currentPrice?.toFixed(2) || '—'}</td>
              <td className={styles.stopPrice}>${o.stopPrice?.toFixed(2) || '—'}</td>
              <td className={styles.gtdDate}>{gtdExp}</td>
              <td style={{ fontSize: 12 }}>{o.sector}</td>
              <td style={{ fontSize: 12 }}>{o.weeklyRsi?.toFixed(0) || '—'}</td>
              <td>{o.filteredRank}</td>
              <td className={styles.killScore}>{o.killScore}</td>
              <td>
                <span className={styles.tierCell} style={{
                  background: tierColor(o.tier),
                  color: tierTextColor(o.tier),
                }}>
                  {o.tier}
                </span>
              </td>
              <td>
                {o.inPortfolio
                  ? <span style={{ color: '#2563eb', fontWeight: 600, fontSize: 11 }}>IN PORTFOLIO</span>
                  : <span style={{ color: '#22c55e', fontWeight: 600, fontSize: 11 }}>NEW</span>
                }
              </td>
            </tr>
          );
        })}
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
