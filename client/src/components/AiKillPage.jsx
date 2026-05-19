import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { fetchLatestAiKill, runAiKill, fetchNav } from '../services/api';
import AiTickerChartModal from './AiTickerChartModal';
import { computeWeeksAgo } from '../utils/dateUtils';
import { sizePosition, isEtfTicker } from '../utils/sizingUtils';
import pantherHead from '../assets/panther head.png';
import styles from './AiKillPage.module.css';

const TIERS = [
  { name: 'ALPHA AI KILL', color: '#15803d', textColor: '#ffffff' },
  { name: 'STRIKING',      color: '#16a34a', textColor: '#ffffff' },
  { name: 'HUNTING',       color: '#22c55e', textColor: '#111111' },
  { name: 'POUNCING',      color: '#86efac', textColor: '#111111' },
  { name: 'COILING',       color: '#ca8a04', textColor: '#ffffff' },
  { name: 'STALKING',      color: '#eab308', textColor: '#111111' },
  { name: 'TRACKING',      color: '#fde047', textColor: '#111111' },
  { name: 'PROWLING',      color: '#b91c1c', textColor: '#ffffff' },
  { name: 'STIRRING',      color: '#ef4444', textColor: '#ffffff' },
  { name: 'DORMANT',       color: '#fca5a5', textColor: '#111111' },
];

function getTierConfig(tierName) {
  return TIERS.find(t => t.name === tierName) || TIERS[9];
}

const COL_INFO = {
  killScore: 'The overall Kill Score combines sector alignment, entry quality (gap + slope), signal freshness, and the market regime multiplier into one number. Higher = stronger trade setup. Scoring runs daily at ~5:30pm ET.',
  tier: 'Tier is determined by Kill Score. ALPHA AI KILL (≥130) is the strongest — the PNTHR has its teeth in. STRIKING (≥100) through DORMANT (<0) rank setups from strongest to weakest. Focus on HUNTING tier and above for the best trade opportunities.',
  signal: 'BL = Buy Long (price crossed above its sector-optimized EMA with a rising slope). SS = Sell Short (crossed below with a falling slope). The +N shows how many weeks since the signal fired — fresher signals (lower N) score higher.',
  sector: 'The AI sector this stock belongs to. There are 14 proprietary AI sectors that group the 300 AI Universe stocks by theme (Hyperscalers, Software, Cybersecurity, Robotics, etc.).',
  sectorStatus: 'Shows whether the sector\'s trend is favorable. BULLISH (GO) = the sector is above its optimized EMA and trending up. BEARISH (NO_GO) = below and trending down. NEUTRAL = mixed. Trading with a BULLISH sector adds +15 to the score; against it costs -15.',
  sectorD2: 'The sector alignment score (±15 points). +15 = you\'re trading in the same direction as the sector trend (long in a BULLISH sector, short in a BEARISH one). -15 = you\'re fighting the sector. This is one of the biggest score drivers.\n\nIdeal: +15 (sector fully aligned with your trade direction).',
  gapPct: 'How far the stock price is from its sector-optimized EMA, as a percentage. Green (≥12%) = strong gap, ideal entry. Yellow (9-12%) = moderate gap, acceptable. Grey (<9%) = tight gap, may want to wait for more separation before entering.\n\nIdeal: ≥12% (green) — confirms strong trend separation.',
  slopePct: 'The annualized rate of change of the stock\'s EMA over the last 8 weeks. Green (<50%) = steady, controlled trend. Yellow (50-65%) = accelerating, use caution. Red (>65%) = overheated slope, the move may be extended.\n\nIdeal: <50% (green) — steady, sustainable trend.',
  price: 'Current market price of the stock as of the last weekly bar close.',
  riskPct: 'The distance from entry price to the initial protective stop, as a percentage of entry price. Lower risk % = tighter stop = less capital at risk per share. Under 5% is ideal; 5-10% is acceptable; above 10% means wider risk per trade.',
  l1Shares: 'The number of shares for your first lot (L1 = "The Scent"), sized to your account NAV. L1 is 35% of the total pyramid position. This is the initial entry — if the stock works, you add L2-L5 at higher prices.',
  totalShares: 'Total shares across all 5 pyramid lots (L1-L5) if fully filled. This is the maximum position size based on your NAV and the 10% per-ticker concentration cap. Your actual position starts at L1 and builds up only if the trade works.',
  multiplier: 'The PAI300 regime multiplier (0.70×–1.30×). In a bull regime (PAI300 above its 36W EMA), long signals are amplified up to 1.30× and shorts dampened to 0.70×. Bear regime is the reverse. This multiplies the entire score.',
  status: 'Shows ★ NEW when the signal just fired this week. New signals get a +10 freshness bonus. After the first week, the score loses -1 point per week of age.',
};

function InfoIcon({ text, onShow }) {
  return (
    <span
      className={styles.infoIcon}
      onClick={e => { e.stopPropagation(); onShow(text, e); }}
    >ⓘ</span>
  );
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

export default function AiKillPage() {
  const { isAdmin } = useAuth();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [chartTickers, setChartTickers] = useState([]);
  const [chartIndex, setChartIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [nav, setNav] = useState(100_000);
  const [infoPopup, setInfoPopup] = useState(null);

  function showInfo(text, e) {
    const rect = e.currentTarget.getBoundingClientRect();
    setInfoPopup({ text, x: rect.left, y: rect.bottom + 6 });
  }

  useEffect(() => {
    fetchNav()
      .then(d => { if (d?.nav) setNav(d.nav); })
      .catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    fetchLatestAiKill()
      .then(d => { setDoc(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const scores = useMemo(() => {
    if (!doc?.scores) return [];
    let arr = doc.scores;
    if (filter === 'bl')    arr = arr.filter(s => s.signal === 'BL');
    if (filter === 'ss')    arr = arr.filter(s => s.signal === 'SS');
    if (filter === 'top10') arr = arr.slice(0, 10);
    if (tierFilter !== 'all') arr = arr.filter(s => s.tierName === tierFilter);
    return arr;
  }, [doc, filter, tierFilter]);

  const onRun = async () => {
    setRunning(true); setRunMsg(null);
    try {
      const r = await runAiKill();
      setRunMsg(`Scored ${r.scoredCount} names`);
      load();
    } catch (e) {
      setRunMsg(`Failed: ${e.message}`);
    } finally { setRunning(false); }
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherLogo} />
            PNTHR AI Kill
          </h1>
          <p className={styles.subtitle}>
            v1 — (D2 + D3 + D4) × D1
            <span style={{
              marginLeft: 10, padding: '3px 8px', background: '#3b82f6', color: '#fff',
              borderRadius: 3, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
            }}>AI 300</span>
          </p>
        </div>
        <div className={styles.headerRight}>
          {isAdmin && (
            <button className={styles.refreshBtn} onClick={onRun} disabled={running}>
              {running ? 'RUNNING…' : 'RECOMPUTE'}
            </button>
          )}
          <button className={styles.refreshBtn} onClick={load} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── Context Banner ──────────────────────────────────────────── */}
      {doc && (
        <div className={styles.contextBanner}>
          <span style={{ color: '#9ca3af', fontWeight: 600 }}>Week of</span>
          <strong style={{ color: '#fff' }}>{doc.weekOf}</strong>
          {doc.pai300Bull != null && (
            <span style={{
              padding: '3px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
              background: doc.pai300Bull ? '#16a34a' : '#dc2626', color: '#fff',
            }}>
              {doc.pai300Bull ? 'PAI300 BULL' : 'PAI300 BEAR'}
            </span>
          )}
          <span className={styles.contextMeta}>
            {doc.generatedAt && `generated ${new Date(doc.generatedAt).toLocaleString()}`}
          </span>
        </div>
      )}

      {/* ── Tier Summary Cards ──────────────────────────────────────── */}
      {doc?.tierBreakdown && (
        <div className={styles.tierCards}>
          {TIERS.map(tier => {
            const count = doc.tierBreakdown[tier.name] || 0;
            const isActive = tierFilter === tier.name;
            return (
              <button
                key={tier.name}
                className={`${styles.tierCard} ${isActive ? styles.tierCardActive : ''}`}
                style={{ borderColor: tier.color }}
                onClick={() => setTierFilter(isActive ? 'all' : tier.name)}
              >
                <span className={styles.tierCardCount} style={{ color: tier.color }}>{count}</span>
                <span className={styles.tierCardName}>{tier.name}</span>
              </button>
            );
          })}
          <button
            className={`${styles.tierCard} ${tierFilter === 'all' ? styles.tierCardActive : ''}`}
            style={{ borderColor: '#555' }}
            onClick={() => setTierFilter('all')}
          >
            <span className={styles.tierCardCount} style={{ color: '#aaa' }}>{doc?.scoredCount || 0}</span>
            <span className={styles.tierCardName}>ALL TIERS</span>
          </button>
        </div>
      )}

      {/* ── Controls Bar ────────────────────────────────────────────── */}
      <div className={styles.controlsBar}>
        <div className={styles.controlsLeft}>
          {[
            { k: 'all',   label: 'All' },
            { k: 'top10', label: 'Top 10' },
            { k: 'bl',    label: 'BL only' },
            { k: 'ss',    label: 'SS only' },
          ].map(o => (
            <button
              key={o.k}
              className={`${styles.sideTab} ${filter === o.k ? styles.sideTabActive : ''}`}
              onClick={() => setFilter(o.k)}
            >{o.label}</button>
          ))}
        </div>
        <span className={styles.controlsMeta}>
          {scores.length} of {doc?.scoredCount || 0} shown
        </span>
      </div>
      {runMsg && <div style={{ fontSize: 11, color: '#fcf000', marginBottom: 8 }}>{runMsg}</div>}

      {/* ── Loading / Error ─────────────────────────────────────────── */}
      {loading && !doc && (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading scores…</p>
        </div>
      )}
      {error && <div className={styles.errorState}>{error}</div>}

      {/* ── Scores Table ────────────────────────────────────────────── */}
      {scores.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ textAlign: 'center', width: 68 }}>#</th>
                <th style={{ textAlign: 'center' }}>Kill<br/>Score <InfoIcon text={COL_INFO.killScore} onShow={showInfo} /></th>
                <th>Tier <InfoIcon text={COL_INFO.tier} onShow={showInfo} /></th>
                <th>Ticker</th>
                <th>Signal <InfoIcon text={COL_INFO.signal} onShow={showInfo} /></th>
                <th className={styles.sectorGroupLeft}>Sector <InfoIcon text={COL_INFO.sector} onShow={showInfo} /></th>
                <th style={{ textAlign: 'center' }}>Sector<br/>Status <InfoIcon text={COL_INFO.sectorStatus} onShow={showInfo} /></th>
                <th className={styles.sectorGroupRight} style={{ textAlign: 'center' }}>💪 <InfoIcon text={COL_INFO.sectorD2} onShow={showInfo} /></th>
                <th style={{ textAlign: 'right' }}>Gap % <InfoIcon text={COL_INFO.gapPct} onShow={showInfo} /></th>
                <th style={{ textAlign: 'right' }}>Slope % <InfoIcon text={COL_INFO.slopePct} onShow={showInfo} /></th>
                <th style={{ textAlign: 'right' }}>Price <InfoIcon text={COL_INFO.price} onShow={showInfo} /></th>
                <th style={{ textAlign: 'right' }}>Risk % <InfoIcon text={COL_INFO.riskPct} onShow={showInfo} /></th>
                <th style={{ textAlign: 'right' }}>L1<br/>Shares <InfoIcon text={COL_INFO.l1Shares} onShow={showInfo} /></th>
                <th style={{ textAlign: 'right' }}>Total<br/>Shares <InfoIcon text={COL_INFO.totalShares} onShow={showInfo} /></th>
                <th style={{ textAlign: 'right' }}>Multi&shy;plier <InfoIcon text={COL_INFO.multiplier} onShow={showInfo} /></th>
                <th>Status <InfoIcon text={COL_INFO.status} onShow={showInfo} /></th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s, idx) => {
                const tier = getTierConfig(s.tierName);
                const isTop10 = s.killRank <= 10;
                const direction = s.signal === 'BL' ? 'LONG' : 'SHORT';
                const sizing = (s.currentPrice && s.stopPrice && nav)
                  ? sizePosition({
                      netLiquidity: nav,
                      entryPrice: s.currentPrice,
                      stopPrice: s.stopPrice,
                      maxGapPct: 0,
                      direction,
                      isETF: isEtfTicker(s.ticker),
                    })
                  : null;
                return (
                  <tr
                    key={s.ticker}
                    className={`${styles.row}${selectedTicker === s.ticker ? ` ${styles.selectedRow}` : ''}${isTop10 ? ` ${styles.top10Row}` : ''}`}
                    onClick={() => setSelectedTicker(s.ticker)}
                  >
                    {/* Kill Rank */}
                    <td className={styles.killRankCell}>{s.killRank}</td>

                    {/* Kill Score — pill badge */}
                    <td className={styles.scoreCell}>
                      <span
                        className={styles.scoreBadge}
                        style={{ background: tier.color, color: tier.textColor }}
                      >
                        {s.total?.toFixed(1)}
                      </span>
                    </td>

                    {/* Tier badge */}
                    <td>
                      <span
                        className={styles.tierBadge}
                        style={{ background: tier.color, color: tier.textColor }}
                      >
                        {s.tierName}
                      </span>
                    </td>

                    {/* Ticker — click opens chart */}
                    <td
                      className={`${styles.tickerCell} ${styles.tickerClickable}`}
                      onClick={e => {
                        e.stopPropagation();
                        const tickers = scores.map(x => x.ticker);
                        setChartTickers(tickers);
                        setChartIndex(tickers.indexOf(s.ticker));
                      }}
                    >
                      <span className={styles.tickerText}>{s.ticker}</span>
                    </td>

                    {/* Signal */}
                    <td>
                      <span className={s.signal === 'BL' ? styles.sigBadgeBL : styles.sigBadgeSS}>
                        {s.signal}
                        {(() => {
                          const n = computeWeeksAgo(s.signalDate, s.lastBarDate);
                          return n != null ? `+${n}` : '';
                        })()}
                      </span>
                    </td>

                    {/* Sector */}
                    <td className={styles.sectorGroupLeft} style={{ fontSize: 12, color: '#666' }}>
                      S{s.sectorId} {s.sectorName?.split(' ').slice(0, 2).join(' ')}
                    </td>

                    {/* Sector Status */}
                    <td style={{ textAlign: 'center' }}>
                      {s.sectorTier === 'GO'
                        ? <span className={styles.sigBadgeBL}>BULLISH</span>
                        : s.sectorTier === 'NO_GO'
                          ? <span className={styles.sigBadgeSS}>BEARISH</span>
                          : <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: '#854d0e', color: '#fde047', letterSpacing: '0.04em' }}>NEUTRAL</span>}
                    </td>

                    {/* Sector D2 score (💪) */}
                    <td className={`${styles.sectorGroupRight} ${styles.dimCell}`} style={{ textAlign: 'center', fontWeight: 700, color: s.scores?.d2 > 0 ? '#16a34a' : s.scores?.d2 < 0 ? '#dc2626' : '#666' }}>
                      {s.scores?.d2 > 0 ? `+${s.scores.d2}` : s.scores?.d2}
                    </td>

                    {/* Gap % */}
                    <td className={styles.dimCell} style={{ color: Math.abs(s.gapPct ?? 0) >= 12 ? '#16a34a' : Math.abs(s.gapPct ?? 0) >= 9 ? '#ca8a04' : '#999' }}>
                      {s.gapPct != null ? `${Math.abs(s.gapPct).toFixed(1)}%` : '—'}
                    </td>

                    {/* Slope % */}
                    <td className={styles.dimCell} style={{ color: (s.slopePct ?? 999) < 50 ? '#16a34a' : (s.slopePct ?? 999) < 65 ? '#ca8a04' : '#dc2626' }}>
                      {s.slopePct != null ? `${s.slopePct.toFixed(1)}%` : '—'}
                    </td>

                    {/* Price */}
                    <td className={styles.priceCell}>{fmtUsd(s.currentPrice)}</td>

                    {/* Risk % */}
                    <td className={styles.dimCell}>
                      {s.riskPct != null ? `${s.riskPct.toFixed(1)}%` : '—'}
                    </td>

                    {/* L1 Shares */}
                    <td className={styles.dimCell} style={{ fontWeight: 700, color: '#333' }}>
                      {sizing ? sizing.lot1Shares : '—'}
                    </td>

                    {/* Total Lot Shares (L1-L5) */}
                    <td className={styles.dimCell} style={{ fontWeight: 700, color: '#333' }}>
                      {sizing ? sizing.totalShares : '—'}
                    </td>

                    {/* Multiplier (D1) */}
                    <td className={styles.dimCell}>{s.scores?.d1?.toFixed(2)}×</td>

                    {/* Status */}
                    <td>
                      {s.isNewSignal
                        ? <span style={{ color: '#b45309', fontWeight: 700, fontSize: 10, letterSpacing: '0.04em' }}>★ NEW</span>
                        : <span style={{ color: '#aaa', fontSize: 10 }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div className={styles.footer}>
        Score = (D2 + D3 + D4) × D1.
        D1 PAI300 36W regime mult (0.7×–1.3×).
        D2 sector tier ±15.
        D3 entry quality 0–85 (conviction + slope + tightness).
        D4 freshness +10 NEW / -1 per week stale.
        D5 D6 D7 D8 set to 0 in v1 (rank-history, daily momentum, AI Prey not built yet).
        Cron refreshes daily ~5:30pm ET.
      </div>

      {/* ── Info Popup ────────────────────────────────────────────── */}
      {infoPopup && (
        <div
          className={styles.infoPopupOverlay}
          onClick={() => setInfoPopup(null)}
        >
          <div
            className={styles.infoPopupBox}
            style={{ left: Math.min(infoPopup.x, window.innerWidth - 330), top: infoPopup.y }}
            onClick={e => e.stopPropagation()}
          >
            {infoPopup.text}
          </div>
        </div>
      )}

      {chartTickers.length > 0 && (
        <AiTickerChartModal
          tickers={chartTickers}
          initialIndex={chartIndex}
          onClose={() => setChartTickers([])}
        />
      )}
    </div>
  );
}
