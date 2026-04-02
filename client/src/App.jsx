import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AuthContext } from './AuthContext';
import { QueueProvider, useQueue } from './contexts/QueueContext';
import { AnalyzeProvider } from './contexts/AnalyzeContext';
import QueueReviewPanel from './components/QueueReviewPanel';
import StockTable from './components/StockTable';
import ChartModal from './components/ChartModal';
import FilterBar from './components/FilterBar';
import Sidebar from './components/Sidebar';
import SectorPage from './components/SectorPage';
import WatchlistPage from './components/WatchlistPage';
import PortfolioPage from './components/PortfolioPage';
import EmaCrossoverPage from './components/EmaCrossoverPage';
import EtfPage from './components/EtfPage';
import CalendarPage from './components/CalendarPage';
import JunglePage from './components/JunglePage';
import SearchPage from './components/SearchPage';
import PreyPage from './components/PreyPage';
import ApexPage from './components/ApexPage';
import CommandCenter from './components/CommandCenter';
import JournalPage from './components/JournalPage';
import NewsPage from './components/NewsPage';
import PulsePage from './components/PulsePage';
import SignalHistoryPage from './components/SignalHistoryPage';
import HistoryPage from './components/HistoryPage';
import KillTestPage from './components/KillTestPage';
import AssistantPage from './components/AssistantPage';
import LoginPage from './components/LoginPage';
import { fetchTopStocks, fetchShortStocks, fetchAvailableDates, fetchRankingByDate, fetchSignals, fetchLaserSignals, fetchEarnings, fetchUserProfile, fetchIbkrDiscrepancies, fetchHourlyEma, setAuthToken, clearAuthToken, setOnUnauthorized, authHeaders, API_BASE } from './services/api';
import { LOT_NAMES, LOT_OFFSETS } from './utils/sizingUtils';
import { computeWeeksAgo } from './utils/dateUtils';
import './App.css';

function calcReadyLots(positions) {
  const alerts = [];
  for (const p of positions) {
    if (p.status !== 'ACTIVE') continue;
    const fills = p.fills || {};
    const filledLotNums = Object.entries(fills).filter(([, f]) => f.filled).map(([k]) => +k);
    const highFilled = filledLotNums.length > 0 ? Math.max(...filledLotNums) : 0;
    if (highFilled >= 5) continue;
    const nextLot = highFilled + 1;
    if (nextLot < 2 || nextLot > 5) continue; // skip Lot 1 — user already knows about initial entry
    const isLong = p.direction === 'LONG';
    const anchor = fills[1]?.filled && fills[1]?.price ? +fills[1].price : (p.entryPrice || 0);
    if (!anchor) continue;
    const trigger = isLong
      ? +(anchor * (1 + LOT_OFFSETS[nextLot - 1])).toFixed(2)
      : +(anchor * (1 - LOT_OFFSETS[nextLot - 1])).toFixed(2);
    // Time gate: Lot 2 requires 5 trading days since Lot 1 fill
    if (nextLot === 2 && (p.tradingDaysActive ?? 0) < 5) continue;
    const cp = p.currentPrice;
    if (!cp) continue;
    const priceReady = isLong ? cp >= trigger : cp <= trigger;
    if (!priceReady) continue;
    alerts.push({ ticker: p.ticker, direction: p.direction, lot: nextLot, lotName: LOT_NAMES[nextLot - 1], trigger, currentPrice: cp });
  }
  return alerts;
}

function isMarketHoursApp() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960; // 9:30–16:00 ET
}

const defaultFilters = {
  signals: [],
  sectors: [],
  exchanges: [],
  minPrice: '',
  maxPrice: '',
  minRiskDollar: '',
  maxRiskDollar: '',
  minRiskPct: '',
  maxRiskPct: '',
  minWeeksAgo: '',
  maxWeeksAgo: '',
};


function App() {
  const [authToken, setAuthTokenState] = useState(() => localStorage.getItem('pnthr_token'));
  const [currentUser, setCurrentUser] = useState(null); // { email, role, accountSize, defaultPage }
  const [authLoading, setAuthLoading] = useState(true);

  // On mount: validate stored token + register 401 interceptor for expired sessions
  useEffect(() => {
    // Any API call that gets a 401 will trigger this — clears session and shows login
    setOnUnauthorized(() => {
      localStorage.removeItem('pnthr_token');
      clearAuthToken();
      setAuthTokenState(null);
      setCurrentUser(null);
    });

    const token = localStorage.getItem('pnthr_token');
    if (!token) { setAuthLoading(false); return; }
    setAuthToken(token);
    fetchUserProfile()
      .then(profile => {
        setCurrentUser(profile);
        setAuthTokenState(token);
      })
      .catch(() => {
        // Token invalid or expired — clear it
        localStorage.removeItem('pnthr_token');
        clearAuthToken();
        setAuthTokenState(null);
      })
      .finally(() => setAuthLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLogin(token, email, profile, role = 'member') {
    localStorage.setItem('pnthr_token', token);
    setAuthToken(token);
    setAuthTokenState(token);
    setCurrentUser({ email, role, accountSize: profile?.accountSize ?? null, defaultPage: profile?.defaultPage ?? 'long' });
  }

  function handleLogout() {
    localStorage.removeItem('pnthr_token');
    localStorage.removeItem('pnthr_page');
    clearAuthToken();
    setAuthTokenState(null);
    setCurrentUser(null);
  }

  // useCallback must be declared before any conditional returns (Rules of Hooks)
  const updateCurrentUser = useCallback((updates) => {
    setCurrentUser(prev => ({ ...prev, ...updates }));
  }, []); // setCurrentUser is stable from useState — no deps needed

  if (authLoading) return null; // brief flash while validating token
  if (!authToken) return <LoginPage onLogin={handleLogin} />;

  const isAdmin = currentUser?.role === 'admin';
  return (
    <AuthContext.Provider value={{ currentUser, isAdmin, updateCurrentUser }}>
      <AnalyzeProvider>
        <QueueProvider>
          <AppInner currentUser={currentUser} setCurrentUser={setCurrentUser} onLogout={handleLogout} />
        </QueueProvider>
      </AnalyzeProvider>
    </AuthContext.Provider>
  );
}

// ── IBKR Discrepancy Banner ───────────────────────────────────────────────────
// Interactive 2-step fix flow for each discrepancy type.
// States: default → confirming → fixing → fixed (auto-dismiss)

const DISC_COLOR = { CRITICAL: '#dc3545', HIGH: '#ff8c00', MEDIUM: '#ffc107' };
const DISC_BG    = { CRITICAL: 'rgba(220,53,69,0.13)', HIGH: 'rgba(255,140,0,0.10)', MEDIUM: 'rgba(255,193,7,0.08)' };
const DISC_ICON  = { CRITICAL: '🚨', HIGH: '⚠️', MEDIUM: 'ℹ️' };

function IbkrDiscrepancyBanner({ d, onDismiss, onFixed, onNavigate }) {
  const [uiState,     setUiState]     = useState('default');    // default | confirming | fixing | fixed
  const [chosen,      setChosen]      = useState(null);         // 'ibkr' | 'command'
  const [createState, setCreateState] = useState('idle');       // idle | confirming | creating | created | error
  const [closeState,  setCloseState]  = useState('idle');       // idle | confirming | closing | closed | error

  const color = DISC_COLOR[d.severity] || '#ffc107';
  const bg    = DISC_BG[d.severity]    || 'rgba(255,193,7,0.08)';
  const icon  = DISC_ICON[d.severity]  || '⚠️';

  // ── helper to apply the fix via POST /api/positions (surgical patch) ──────
  async function applyFix(fields) {
    if (!d.positionId) return;
    setUiState('fixing');
    try {
      const res = await fetch(`${API_BASE}/api/positions`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.positionId, ...fields }),
      });
      if (!res.ok) throw new Error('save failed');
      setUiState('fixed');
      setTimeout(() => onFixed(), 1500);
    } catch {
      setUiState('confirming'); // revert to confirm on error
    }
  }

  // ── content per type ──────────────────────────────────────────────────────
  function renderContent() {
    if (uiState === 'fixing')  return <span style={{ color: '#aaa', fontSize: 11 }}>Saving…</span>;
    if (uiState === 'fixed')   return <span style={{ color: '#28a745', fontWeight: 700, fontSize: 11 }}>✓ Fixed! Command updated.</span>;

    const dirLabel = d.direction === 'SHORT' ? 'SHORT' : 'LONG';

    // ── CONFIRMING step ────────────────────────────────────────────────────
    if (uiState === 'confirming') {
      let confirmText = '';
      let fixFields   = {};
      if (d.type === 'SHARES_MISMATCH') {
        confirmText = `Fix Command: set ${d.ticker} to ${chosen === 'ibkr' ? d.ibkrShares : d.pnthrShares} shares?`;
        fixFields   = { remainingShares: chosen === 'ibkr' ? d.ibkrShares : d.pnthrShares };
      } else if (d.type === 'PRICE_MISMATCH') {
        confirmText = `Fix Command avg cost for ${d.ticker} to $${chosen === 'ibkr' ? d.ibkrAvg.toFixed(2) : d.pnthrAvg.toFixed(2)}?`;
        fixFields   = { manualAvgCost: chosen === 'ibkr' ? d.ibkrAvg : d.pnthrAvg };
      } else if (d.type === 'STOP_MISSING' || d.type === 'STOP_MISMATCH') {
        const newStop = chosen === 'ibkr' ? d.ibkrStop : d.pnthrStop;
        confirmText   = `Set ${d.ticker} stop to $${(+newStop).toFixed(2)} in Command?`;
        fixFields     = { stopPrice: +newStop };
      }
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#ddd', fontSize: 11 }}>{confirmText}</span>
          <button onClick={() => applyFix(fixFields)} style={btnStyle('#28a745')}>✓ YES – FIX IT</button>
          <button onClick={() => { setUiState('default'); setChosen(null); }} style={btnStyle('#555')}>✗ NO, CANCEL</button>
        </span>
      );
    }

    // ── DEFAULT step — show discrepancy + choice buttons ──────────────────
    if (d.type === 'SHARES_MISMATCH') {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#aaa', fontSize: 11 }}>
            {dirLabel} · <b style={{ color: '#fff' }}>{Math.abs(d.diff)}</b> share diff — which count is correct?
          </span>
          <button onClick={() => { setChosen('command'); setUiState('confirming'); }} style={btnStyle('#555')}>
            Command: {d.pnthrShares} shr
          </button>
          <button onClick={() => { setChosen('ibkr'); setUiState('confirming'); }} style={btnStyle(color)}>
            IBKR: {d.ibkrShares} shr ← use this
          </button>
        </span>
      );
    }
    if (d.type === 'PRICE_MISMATCH') {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#aaa', fontSize: 11 }}>
            Avg cost <b style={{ color }}>{d.diffPct}%</b> off — which is correct?
          </span>
          <button onClick={() => { setChosen('command'); setUiState('confirming'); }} style={btnStyle('#555')}>
            Command: ${d.pnthrAvg?.toFixed(2)}
          </button>
          <button onClick={() => { setChosen('ibkr'); setUiState('confirming'); }} style={btnStyle(color)}>
            IBKR: ${d.ibkrAvg?.toFixed(2)} ← use this
          </button>
        </span>
      );
    }
    if (d.type === 'STOP_MISSING') {
      if (d.ibkrStop) {
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#aaa', fontSize: 11 }}>No stop set! IBKR has a stop order at <b style={{ color: '#fff' }}>${(+d.ibkrStop).toFixed(2)}</b></span>
            <button onClick={() => { setChosen('ibkr'); setUiState('confirming'); }} style={btnStyle(color)}>
              Use IBKR stop: ${(+d.ibkrStop).toFixed(2)}
            </button>
            <button onClick={() => onNavigate('command')} style={btnStyle('#555')}>Set manually in Command →</button>
          </span>
        );
      }
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#aaa', fontSize: 11 }}>No stop in Command or IBKR — position is UNPROTECTED</span>
          <button onClick={() => onNavigate('command')} style={btnStyle(color)}>Set Stop in Command →</button>
        </span>
      );
    }
    if (d.type === 'STOP_MISMATCH') {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#aaa', fontSize: 11 }}>Stop prices differ — which is correct?</span>
          <button onClick={() => { setChosen('command'); setUiState('confirming'); }} style={btnStyle('#555')}>
            Command: ${(+d.pnthrStop).toFixed(2)}
          </button>
          <button onClick={() => { setChosen('ibkr'); setUiState('confirming'); }} style={btnStyle(color)}>
            IBKR: ${(+d.ibkrStop).toFixed(2)} ← use this
          </button>
        </span>
      );
    }
    if (d.type === 'TICKER_MISSING') {
      const isCmdOnly = d.side === 'COMMAND_ONLY';

      // ── COMMAND_ONLY: position in Command but not (or 0) in IBKR ─────────
      if (isCmdOnly) {
        const desc = d.ibkrShowsZero
          ? `In Command (${d.pnthrShares} shr) — IBKR now shows 0 shares (closed there)`
          : `In Command (${d.pnthrShares} shr) — not found in IBKR at all`;

        async function doClose() {
          if (!d.positionId || !d.ibkrExitPrice) return;
          setCloseState('closing');
          try {
            const res = await fetch(`${API_BASE}/api/positions/close`, {
              method: 'POST',
              headers: { ...authHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: d.positionId, exitPrice: d.ibkrExitPrice, exitReason: 'MANUAL' }),
            });
            if (!res.ok) throw new Error('close failed');
            setCloseState('closed');
            setTimeout(() => onFixed(), 1500);
          } catch {
            setCloseState('error');
          }
        }

        if (closeState === 'closing') return <span style={{ color: '#aaa', fontSize: 11 }}>Closing…</span>;
        if (closeState === 'closed')  return <span style={{ color: '#28a745', fontWeight: 700, fontSize: 11 }}>✓ Closed in Command.</span>;
        if (closeState === 'error')   return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#dc3545', fontSize: 11 }}>Close failed — try manually in Command</span>
            <button onClick={() => onNavigate('command')} style={btnStyle('#555')}>Open Command →</button>
          </span>
        );

        if (closeState === 'confirming') return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#ddd', fontSize: 11 }}>
              Close <b style={{ color: '#fff' }}>{d.ticker}</b> at <b style={{ color: '#fff' }}>${d.ibkrExitPrice?.toFixed(2)}</b> (from IBKR)?
            </span>
            <button onClick={doClose} style={btnStyle('#dc3545')}>✓ YES – CLOSE IT</button>
            <button onClick={() => setCloseState('idle')} style={btnStyle('#555')}>✗ CANCEL</button>
          </span>
        );

        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#aaa', fontSize: 11 }}>{desc}</span>
            {d.ibkrExitPrice
              ? <button onClick={() => setCloseState('confirming')} style={btnStyle(color)}>Close in Command →</button>
              : <button onClick={() => onNavigate('command')} style={btnStyle(color)}>Close in Command →</button>
            }
          </span>
        );
      }

      // ── IBKR_ONLY: position in IBKR but missing from Command ─────────────
      // Full create flow: idle → confirming → creating → created/error

      async function doCreate() {
        setCreateState('creating');
        try {
          const res = await fetch(`${API_BASE}/api/ibkr/import-position`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: d.ticker }),
          });
          if (!res.ok) throw new Error('import failed');
          setCreateState('created');
          setTimeout(() => onFixed(), 2000); // refresh discrepancies + positions
        } catch {
          setCreateState('error');
        }
      }

      const dirLabel = d.ibkrDirection || 'LONG';
      const costStr  = d.ibkrAvgCost ? ` @ $${(+d.ibkrAvgCost).toFixed(2)}` : '';
      const staleNote = d.syncIsStale ? `  ⏱ ${d.staleMins}m old` : '';

      if (createState === 'confirming') {
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#ddd', fontSize: 11 }}>
              Create <b style={{ color: '#fff' }}>{dirLabel}</b> card for <b style={{ color: '#fff' }}>{d.ticker}</b> — {d.ibkrShares} shr{costStr} — Lot 1 + PNTHR stop pre-filled. Expand lots after.
            </span>
            <button onClick={doCreate} style={btnStyle('#28a745')}>✓ YES – CREATE IT</button>
            <button onClick={() => setCreateState('idle')} style={btnStyle('#555')}>✗ CANCEL</button>
          </span>
        );
      }
      if (createState === 'creating') {
        return <span style={{ color: '#aaa', fontSize: 11 }}>Creating position in Command…</span>;
      }
      if (createState === 'created') {
        return <span style={{ color: '#28a745', fontWeight: 700, fontSize: 11 }}>✓ Position created! Go to Command to set stop + expand lots.</span>;
      }
      if (createState === 'error') {
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#dc3545', fontSize: 11 }}>Create failed — try again</span>
            <button onClick={() => setCreateState('confirming')} style={btnStyle('#dc3545')}>Retry</button>
          </span>
        );
      }

      // idle — default IBKR_ONLY view
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#aaa', fontSize: 11 }}>
            In IBKR — {dirLabel} {d.ibkrShares} shr{costStr} — NOT in Command{staleNote}
          </span>
          <button onClick={() => setCreateState('confirming')} style={btnStyle(color)}>
            Create in Command →
          </button>
        </span>
      );
    }
    return null;
  }

  function btnStyle(borderColor) {
    return {
      background: 'none',
      border: `1px solid ${borderColor}`,
      color: borderColor === '#555' ? '#999' : borderColor,
      borderRadius: 4,
      padding: '3px 10px',
      fontSize: 11,
      cursor: 'pointer',
      fontWeight: 600,
      whiteSpace: 'nowrap',
      flexShrink: 0,
    };
  }

  return (
    <div style={{
      background: bg,
      borderBottom: `1px solid ${color}33`,
      padding: '8px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 12,
      minHeight: 38,
    }}>
      {/* Severity icon */}
      <span style={{ fontSize: 13, flexShrink: 0 }}>{icon}</span>

      {/* Severity badge */}
      <span style={{ color, fontWeight: 800, flexShrink: 0, fontSize: 10, letterSpacing: '0.06em', minWidth: 56 }}>
        {d.severity}
      </span>

      {/* Ticker — prominent */}
      <span style={{
        fontWeight: 900, fontSize: 13, color: '#fff',
        background: `${color}22`, borderRadius: 4,
        padding: '1px 7px', flexShrink: 0, letterSpacing: '0.04em',
      }}>
        {d.ticker}
      </span>

      {/* Type label */}
      <span style={{ fontSize: 10, color: '#555', flexShrink: 0, letterSpacing: '0.04em' }}>
        {d.type.replace(/_/g, ' ')}
      </span>

      {/* Interactive content */}
      <span style={{ flex: 1 }}>{renderContent()}</span>

      {/* Dismiss button */}
      {uiState === 'default' && (
        <button
          onClick={onDismiss}
          style={{ background: 'none', border: `1px solid #333`, color: '#555', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── EMA Alert Banner ──────────────────────────────────────────────────────────
// Displays a single row per active 21H EMA crossover alert.
// CRITICAL/HIGH → red bg, white text  (act now)
// MEDIUM        → yellow bg, black text (act soon)
// FAVORABLE     → green bg, black text  (good news)
const EMA_BAND = {
  CRITICAL: { bg: '#7f0000', text: '#fff', tickerBg: 'rgba(0,0,0,0.30)', tickerText: '#fff', muted: 'rgba(255,255,255,0.80)', dim: 'rgba(255,255,255,0.60)', icon: '⚡' },
  HIGH:     { bg: '#8b0000', text: '#fff', tickerBg: 'rgba(0,0,0,0.30)', tickerText: '#fff', muted: 'rgba(255,255,255,0.80)', dim: 'rgba(255,255,255,0.60)', icon: '⚠️' },
  MEDIUM:   { bg: '#f9a825', text: '#000', tickerBg: 'rgba(0,0,0,0.15)', tickerText: '#000', muted: 'rgba(0,0,0,0.65)',       dim: 'rgba(0,0,0,0.45)',       icon: '〰️' },
  FAVORABLE:{ bg: '#2e7d32', text: '#fff', tickerBg: 'rgba(0,0,0,0.20)', tickerText: '#fff', muted: 'rgba(255,255,255,0.75)', dim: 'rgba(255,255,255,0.55)', icon: '✅' },
};

function EmaAlertBanner({ alert: a, onDismiss }) {
  const band = EMA_BAND[a.urgency] || EMA_BAND.MEDIUM;

  const sideLabel = a.emaSide === 'ABOVE' ? '▲ ABOVE' : '▼ BELOW';
  const v1Sign    = a.velocity1m >= 0 ? '+' : '';
  const pSign     = a.pnlPerMin  >= 0 ? '+' : '';
  const crossNote = a.crossed ? ' (just crossed)' : '';
  const adverse   = a.isAdverse
    ? `${sideLabel} 21H EMA — adverse for ${a.direction}${crossNote}`
    : `${sideLabel} 21H EMA — favorable for ${a.direction}${crossNote}`;

  return (
    <div style={{
      background: band.bg,
      padding: '5px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 11,
      flexWrap: 'wrap',
    }}>
      <span style={{ color: band.text, fontWeight: 800, whiteSpace: 'nowrap' }}>{band.icon} {a.urgency}</span>
      <span style={{ background: band.tickerBg, color: band.tickerText, borderRadius: 3, padding: '1px 7px', fontWeight: 800, fontSize: 11, whiteSpace: 'nowrap' }}>{a.ticker}</span>
      <span style={{ color: band.muted }}>{a.direction}</span>
      <span style={{ color: band.text, flex: 1, minWidth: 180 }}>{adverse}</span>
      <span style={{ color: band.muted, whiteSpace: 'nowrap' }}>
        velocity: <b style={{ color: band.text }}>{v1Sign}{a.velocity1m.toFixed(2)}%/min</b>
      </span>
      {a.dollarAtRisk > 0 && (
        <span style={{ color: band.muted, whiteSpace: 'nowrap' }}>
          P&amp;L: <b style={{ color: band.text }}>{pSign}${Math.abs(a.pnlPerMin).toFixed(0)}/min</b>
          &nbsp;(<b style={{ color: band.text }}>{a.riskPctPerMin.toFixed(1)}% of risk/min</b>)
        </span>
      )}
      <span style={{ color: band.dim, whiteSpace: 'nowrap', fontSize: 10 }}>
        EMA: ${a.ema21h.toFixed(2)} · price: ${a.currentPrice.toFixed(2)}
      </span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: band.muted, cursor: 'pointer', fontSize: 15, padding: '0 4px', lineHeight: 1, flexShrink: 0 }}>×</button>
    </div>
  );
}

function AppInner({ currentUser, setCurrentUser, onLogout }) {
  const { isAuthenticated, queueSize, showQueuePanel, setShowQueuePanel, sendSuccess } = useQueue();
  const isAdmin = currentUser?.role === 'admin';
  const [lotAlerts,         setLotAlerts]         = useState([]);
  const [positions,         setPositions]         = useState([]); // full positions for EMA alerts
  const [commandRefreshKey, setCommandRefreshKey] = useState(0);  // increments to trigger Command refetch

  // ── Rolling price history (last 10 ticks per ticker, in-memory only) ────────
  const priceHistoryRef = useRef({}); // { [ticker]: [{price, time}] }
  const prevEmaSideRef  = useRef({}); // { [ticker]: 'ABOVE' | 'BELOW' }

  useEffect(() => {
    if (!isAuthenticated) { setLotAlerts([]); setPositions([]); return; }
    const fetchAlerts = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/positions`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const pos  = data.positions || [];
        setLotAlerts(calcReadyLots(pos));
        setPositions(pos);
        // Update rolling price history (used for velocity computation)
        const now = Date.now();
        for (const p of pos) {
          if (!p.ticker || !p.currentPrice) continue;
          const t = p.ticker.toUpperCase();
          if (!priceHistoryRef.current[t]) priceHistoryRef.current[t] = [];
          priceHistoryRef.current[t].push({ price: +p.currentPrice, time: now });
          if (priceHistoryRef.current[t].length > 10) priceHistoryRef.current[t].shift();
        }
      } catch { /* ignore */ }
    };
    fetchAlerts();
    const iv = setInterval(() => { if (isMarketHoursApp()) fetchAlerts(); }, 60000);
    return () => clearInterval(iv);
  }, [isAuthenticated]);

  // ── 21H EMA values — fetched from server (60-min server cache) ──────────────
  const [emaValues, setEmaValues] = useState({}); // { [TICKER]: { ema21h, computedAt } }

  useEffect(() => {
    if (!isAuthenticated) { setEmaValues({}); return; }
    const load = async () => {
      try { setEmaValues(await fetchHourlyEma()); } catch { /* non-fatal */ }
    };
    load();
    const iv = setInterval(load, 60 * 60 * 1000); // refresh every hour (server caches per-ticker anyway)
    return () => clearInterval(iv);
  }, [isAuthenticated]);

  // ── EMA crossover alerts — computed every time positions or EMA values update ─
  const [emaAlerts,        setEmaAlerts]        = useState([]);
  const [dismissedEmaKeys, setDismissedEmaKeys] = useState(new Set());

  useEffect(() => {
    if (!positions.length || !Object.keys(emaValues).length) return;

    const alerts = [];
    for (const p of positions) {
      if (p.status !== 'ACTIVE') continue;
      const ticker  = p.ticker?.toUpperCase();
      const emaData = emaValues[ticker];
      if (!emaData?.ema21h || !p.currentPrice) continue;

      const price   = +p.currentPrice;
      const ema21h  = +emaData.ema21h;
      const emaSide = price > ema21h ? 'ABOVE' : 'BELOW';
      const prevSide  = prevEmaSideRef.current[ticker];
      const crossed   = prevSide != null && prevSide !== emaSide;
      prevEmaSideRef.current[ticker] = emaSide;

      // Is this side adverse to the position direction?
      const direction = p.direction || 'LONG';
      const isAdverse = (direction === 'LONG' && emaSide === 'BELOW')
                     || (direction === 'SHORT' && emaSide === 'ABOVE');

      // Velocity from rolling price history
      const hist = priceHistoryRef.current[ticker] || [];
      let velocity1m = 0, velocity5m = 0;
      if (hist.length >= 2) {
        const prev1 = hist[hist.length - 2];
        const cur   = hist[hist.length - 1];
        const mins  = Math.max((cur.time - prev1.time) / 60000, 0.1);
        velocity1m  = ((cur.price - prev1.price) / prev1.price * 100) / mins;
      }
      if (hist.length >= 6) {
        const prev5 = hist[hist.length - 6];
        const cur   = hist[hist.length - 1];
        const mins  = Math.max((cur.time - prev5.time) / 60000, 0.1);
        velocity5m  = ((cur.price - prev5.price) / prev5.price * 100) / mins;
      }

      // P&L velocity ($ per minute, positive = gaining)
      const fills       = p.fills || {};
      const filledArr   = Object.values(fills).filter(f => f?.filled);
      const totalShares = filledArr.reduce((s, f) => s + (+f.shares || 0), 0);
      const totalCost   = filledArr.reduce((s, f) => s + (+f.shares || 0) * (+f.price || 0), 0);
      const avgCost     = totalShares > 0 ? totalCost / totalShares : (p.entryPrice || price);
      const dollarPerMinPerShare = (velocity1m / 100) * price; // $/min/share
      const pnlPerMin   = (direction === 'LONG' ? 1 : -1) * dollarPerMinPerShare * totalShares;

      // Dollar at risk for this position
      let dollarAtRisk = 0;
      if (p.stopPrice && totalShares > 0) {
        const riskPerShare = direction === 'LONG'
          ? Math.max(avgCost - p.stopPrice, 0)
          : Math.max(p.stopPrice - avgCost, 0);
        dollarAtRisk = riskPerShare * totalShares;
      }

      // % of risk capital being lost per minute
      const riskPctPerMin = dollarAtRisk > 0 ? Math.abs(pnlPerMin) / dollarAtRisk * 100 : 0;

      // Urgency — only alert when on adverse side or just crossed favorably
      const velMag = Math.abs(velocity5m);
      let urgency = null;
      if (isAdverse) {
        if (riskPctPerMin >= 5 || velMag >= 0.5)        urgency = 'CRITICAL';
        else if (riskPctPerMin >= 2 || velMag >= 0.2 || crossed) urgency = 'HIGH';
        else if (crossed || velMag >= 0.05)              urgency = 'MEDIUM';
      } else if (crossed) {
        urgency = 'FAVORABLE'; // price returned to favorable side — quiet green alert
      }
      if (!urgency) continue;

      // Auto-clear dismissed key if side has changed (so re-crossing re-fires)
      const dismissKey = `${ticker}:${emaSide}`;
      if (crossed) {
        // When side changes, remove the OLD side's dismiss key so it can fire again later
        const oldKey = `${ticker}:${prevSide}`;
        setDismissedEmaKeys(prev => { const n = new Set(prev); n.delete(oldKey); return n; });
      }

      alerts.push({
        ticker, direction, currentPrice: price, ema21h, emaSide, crossed, isAdverse,
        velocity1m: +velocity1m.toFixed(3),
        velocity5m: +velocity5m.toFixed(3),
        pnlPerMin:  +pnlPerMin.toFixed(2),
        dollarAtRisk: +dollarAtRisk.toFixed(0),
        riskPctPerMin: +riskPctPerMin.toFixed(2),
        urgency,
        dismissKey,
      });
    }

    const ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, FAVORABLE: 3 };
    alerts.sort((a, b) => (ORDER[a.urgency] ?? 9) - (ORDER[b.urgency] ?? 9));
    setEmaAlerts(alerts);
  }, [positions, emaValues]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleEmaAlerts = emaAlerts.filter(a => !dismissedEmaKeys.has(a.dismissKey));

  // ── IBKR discrepancy polling ──────────────────────────────────────────────
  // Active discrepancies; each item has { type, severity, ticker, message, ... }
  const [ibkrDiscrepancies, setIbkrDiscrepancies] = useState([]);
  // Per-session dismissed set — keys are `${type}:${ticker}` strings
  const [dismissedKeys, setDismissedKeys] = useState(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('pnthr_ibkr_dismissed') || '[]')); }
    catch { return new Set(); }
  });

  useEffect(() => {
    if (!isAuthenticated) { setIbkrDiscrepancies([]); return; }
    const load = async () => {
      try {
        const data = await fetchIbkrDiscrepancies();
        if (data.ibkrConnected && data.discrepancies?.length > 0) {
          setIbkrDiscrepancies(data.discrepancies);
        } else {
          setIbkrDiscrepancies([]);
        }
      } catch { /* IBKR not synced — no banner */ }
    };
    load();
    const iv = setInterval(load, 2 * 60 * 1000); // poll every 2 minutes
    return () => clearInterval(iv);
  }, [isAuthenticated]);

  function dismissIbkrDiscrepancy(key) {
    setDismissedKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      try { sessionStorage.setItem('pnthr_ibkr_dismissed', JSON.stringify([...next])); } catch { /* */ }
      return next;
    });
  }

  // Visible = not yet dismissed this session
  const visibleDiscrepancies = ibkrDiscrepancies.filter(d => !dismissedKeys.has(`${d.type}:${d.ticker}`));

  const [activePage, setActivePage] = useState(
    () => localStorage.getItem('pnthr_page') || currentUser?.defaultPage || 'long'
  );
  const [journalInitFilter, setJournalInitFilter] = useState(null);
  const [journalFocusId,    setJournalFocusId]    = useState(null);
  const [journalFocusTicker, setJournalFocusTicker] = useState(null);

  function navigate(page, opts) {
    if (page === 'journal') {
      setJournalInitFilter(opts?.filter || null);
      setJournalFocusId(opts?.focusId || null);
      setJournalFocusTicker(opts?.focusTicker || null);
    } else {
      setJournalInitFilter(null);
      setJournalFocusId(null);
      setJournalFocusTicker(null);
    }
    setActivePage(page);
    localStorage.setItem('pnthr_page', page);
  }
  const scanType = activePage === 'short' ? 'short' : 'long';
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [availableDates, setAvailableDates] = useState([]);
  const [signals, setSignals] = useState({});
  const [laserSignals, setLaserSignals] = useState({});
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [earnings, setEarnings] = useState({});
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [longBatchStats, setLongBatchStats] = useState(null);
  const [shortBatchStats, setShortBatchStats] = useState(null);

  const isScanner = activePage === 'long' || activePage === 'short';

  // Reset filters when tab or date changes
  useEffect(() => {
    setFilters(defaultFilters);
  }, [activePage, selectedDate]);

  // Apply filters (risk values derived here since they need signals data)
  const filteredStocks = useMemo(() => {
    return stocks.filter(stock => {
      const signalData = signals[stock.ticker];
      const stopPrice = signalData?.stopPrice ?? null;
      const riskDollar = stopPrice != null ? Math.abs(stock.currentPrice - stopPrice) : null;
      const riskPct = riskDollar != null ? (riskDollar / stock.currentPrice) * 100 : null;

      const signalKey = signalData
        ? (signalData.isNewSignal ? `NEW_${signalData.signal}` : signalData.signal)
        : 'NONE';
      if (filters.signals.length > 0 && !filters.signals.includes(signalKey)) return false;
      if (filters.sectors.length > 0 && !filters.sectors.includes(stock.sector)) return false;
      if (filters.exchanges.length > 0 && !filters.exchanges.includes(stock.exchange)) return false;
      if (filters.minPrice !== '' && stock.currentPrice < +filters.minPrice) return false;
      if (filters.maxPrice !== '' && stock.currentPrice > +filters.maxPrice) return false;
      if (filters.minRiskDollar !== '' && (riskDollar == null || riskDollar < +filters.minRiskDollar)) return false;
      if (filters.maxRiskDollar !== '' && (riskDollar == null || riskDollar > +filters.maxRiskDollar)) return false;
      if (filters.minRiskPct !== '' && (riskPct == null || riskPct < +filters.minRiskPct)) return false;
      if (filters.maxRiskPct !== '' && (riskPct == null || riskPct > +filters.maxRiskPct)) return false;
      if (filters.minWeeksAgo !== '' || filters.maxWeeksAgo !== '') {
        const weeksAgo = computeWeeksAgo(signalData?.signalDate);
        if (weeksAgo == null) return false;
        if (filters.minWeeksAgo !== '' && weeksAgo < +filters.minWeeksAgo) return false;
        if (filters.maxWeeksAgo !== '' && weeksAgo > +filters.maxWeeksAgo) return false;
      }
      return true;
    });
  }, [stocks, signals, filters]);

  useEffect(() => {
    loadAvailableDates();
  }, []);

  async function loadAvailableDates() {
    try {
      const dates = await fetchAvailableDates();
      setAvailableDates(dates);
      if (dates?.length) setSelectedDate(dates[0].date);
      else setSelectedDate('current');
    } catch (err) {
      console.error('Failed to load available dates:', err);
      setSelectedDate('current');
    }
  }

  // Load stocks when viewing a scan and a date is selected
  useEffect(() => {
    if (!isScanner || selectedDate == null) return;
    if (selectedDate === 'current') loadCurrentStocks(true);
    else loadStocksByDate(selectedDate);
  }, [activePage, selectedDate]);

  async function loadCurrentStocks(forceRefresh = false) {
    try {
      setLoading(true);
      setError(null);
      const fetchFn = scanType === 'short' ? fetchShortStocks : fetchTopStocks;
      const data = await fetchFn(forceRefresh);
      setStocks(data);
      setSelectedDate('current');
      setSignals({});
      setLaserSignals({});
      setSignalsLoading(true);
      const tickers = data.map(s => s.ticker);
      const opts = { shortList: scanType === 'short' };
      Promise.all([
        fetchSignals(tickers, opts).catch(err => { console.error('PNTHR signals error:', err); return {}; }),
        fetchLaserSignals(tickers, opts).catch(err => { console.error('Laser signals error:', err); return {}; }),
      ]).then(([pnthr, laser]) => {
        setSignals(pnthr);
        setLaserSignals(laser);
        setSignalsLoading(false);
        if (scanType === 'long') computeAndSetLongStats(pnthr);
        else if (scanType === 'short') computeAndSetShortStats(pnthr);
      }).catch(err => console.error('[App] Signal fetch error:', err));
      fetchEarnings(tickers).then(result => setEarnings(result)).catch(err => console.error('Earnings fetch error:', err));
    } catch (err) {
      setError('Failed to load stock data. Please try again later.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function loadStocksByDate(date) {
    if (date === 'current') {
      loadCurrentStocks(true);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const data = await fetchRankingByDate(date);
      const list = scanType === 'short' ? (data.shortRankings || []) : (data.rankings || []);
      setStocks(list);
      setSelectedDate(date);
      setSignals({});
      setLaserSignals({});
      setSignalsLoading(true);
      const tickers = list.map(s => s.ticker);
      const opts = { shortList: scanType === 'short' };
      Promise.all([
        fetchSignals(tickers, opts).catch(err => { console.error('PNTHR signals error:', err); return {}; }),
        fetchLaserSignals(tickers, opts).catch(err => { console.error('Laser signals error:', err); return {}; }),
      ]).then(([pnthr, laser]) => {
        setSignals(pnthr);
        setLaserSignals(laser);
        setSignalsLoading(false);
        if (scanType === 'long') computeAndSetLongStats(pnthr);
        else if (scanType === 'short') computeAndSetShortStats(pnthr);
      }).catch(err => console.error('[App] Signal fetch error:', err));
      fetchEarnings(tickers).then(result => setEarnings(result)).catch(err => console.error('Earnings fetch error:', err));
    } catch (err) {
      setError(`Failed to load data for ${date}. Please try again.`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function computeAndSetLongStats(pnthrSignals) {
    const closed = Object.values(pnthrSignals).filter(s => s.signal === 'BE' && s.profitDollar != null);
    if (closed.length === 0) { setLongBatchStats(null); return; }
    const wins = closed.filter(s => s.profitDollar > 0);
    const avgDollar = closed.reduce((sum, s) => sum + s.profitDollar, 0) / closed.length;
    const avgPct    = closed.reduce((sum, s) => sum + s.profitPct,    0) / closed.length;
    setLongBatchStats({ total: closed.length, wins: wins.length, winRate: (wins.length / closed.length) * 100, avgDollar, avgPct });
  }

  function computeAndSetShortStats(pnthrSignals) {
    const closed = Object.values(pnthrSignals).filter(s => s.signal === 'SE' && s.profitDollar != null);
    if (closed.length === 0) { setShortBatchStats(null); return; }
    const wins = closed.filter(s => s.profitDollar > 0);
    const avgDollar = closed.reduce((sum, s) => sum + s.profitDollar, 0) / closed.length;
    const avgPct    = closed.reduce((sum, s) => sum + s.profitPct,    0) / closed.length;
    setShortBatchStats({ total: closed.length, wins: wins.length, winRate: (wins.length / closed.length) * 100, avgDollar, avgPct });
  }

  function formatDate(dateString) {
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function handleRowClick(_stock, sortedIdx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(sortedIdx);
  }

  return (
    <div className="app">
      <Sidebar activePage={activePage} onNavigate={navigate} currentUser={currentUser} isAdmin={isAdmin} onLogout={onLogout} longStats={longBatchStats} shortStats={shortBatchStats} />

      <div className="content-wrapper">
        {/* Lot Ready banner — visible on all pages when a pyramid lot is triggered */}
        {isAuthenticated && lotAlerts.length > 0 && (
          <div style={{
            background: 'linear-gradient(90deg, rgba(40,167,69,0.15), rgba(40,167,69,0.05))',
            borderBottom: '1px solid rgba(40,167,69,0.3)',
            padding: '8px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 12,
            flexWrap: 'wrap',
          }}>
            <span style={{ color: '#28a745', fontWeight: 800, whiteSpace: 'nowrap' }}>
              🎯 {lotAlerts.length} LOT{lotAlerts.length > 1 ? 'S' : ''} READY
            </span>
            {lotAlerts.map((a, i) => (
              <span key={i} style={{ color: '#aaa' }}>
                <b style={{ color: '#fff' }}>{a.ticker}</b>
                {' '}Lot {a.lot} ({a.lotName}) — trigger ${a.trigger.toFixed(2)}
                {i < lotAlerts.length - 1 ? <span style={{ color: '#444', margin: '0 6px' }}>|</span> : null}
              </span>
            ))}
            <button
              onClick={() => navigate('command')}
              style={{
                marginLeft: 'auto',
                background: '#28a745',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                padding: '4px 14px',
                fontWeight: 700,
                fontSize: 11,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              GO TO COMMAND →
            </button>
          </div>
        )}

        {/* ── 21H EMA Crossover Alerts — fires when price crosses 21H EMA on active positions ── */}
        {isAuthenticated && visibleEmaAlerts.length > 0 && (
          <>
            <div style={{
              background: 'rgba(30,30,30,0.95)',
              borderBottom: '1px solid #333',
              padding: '5px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 11,
            }}>
              <span style={{ color: '#fcf000', fontWeight: 800, letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                📈 21H EMA — {visibleEmaAlerts.length} ALERT{visibleEmaAlerts.length > 1 ? 'S' : ''}
              </span>
              {visibleEmaAlerts.some(a => a.urgency === 'CRITICAL') && (
                <span style={{ color: '#dc3545', fontSize: 10, fontWeight: 700, animation: 'none' }}>
                  ⚡ CRITICAL — check positions immediately
                </span>
              )}
              {visibleEmaAlerts.length >= 3 && (
                <button
                  onClick={() => setDismissedEmaKeys(prev => new Set([...prev, ...visibleEmaAlerts.map(a => a.dismissKey)]))}
                  style={{ marginLeft: 'auto', background: 'none', border: '1px solid #333', color: '#666', borderRadius: 4, padding: '2px 10px', fontSize: 10, cursor: 'pointer' }}
                >
                  DISMISS ALL
                </button>
              )}
            </div>
            {visibleEmaAlerts.map(a => (
              <EmaAlertBanner
                key={a.dismissKey}
                alert={a}
                onDismiss={() => setDismissedEmaKeys(prev => new Set([...prev, a.dismissKey]))}
              />
            ))}
          </>
        )}

        {/* ── IBKR Discrepancy Banners — interactive fix flow, persistent per session ── */}
        {visibleDiscrepancies.length > 0 && (
          <>
            {/* Header bar when 3+ issues — shows count + dismiss all */}
            {visibleDiscrepancies.length >= 3 && (
              <div style={{
                background: 'rgba(220,53,69,0.08)',
                borderBottom: '1px solid rgba(220,53,69,0.15)',
                padding: '6px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontSize: 11,
              }}>
                <span style={{ color: '#dc3545', fontWeight: 800, letterSpacing: '0.05em' }}>
                  🔗 IBKR — {visibleDiscrepancies.length} DISCREPANCIES NEED ATTENTION
                </span>
                <button
                  onClick={() => {
                    const allKeys = visibleDiscrepancies.map(d => `${d.type}:${d.ticker}`);
                    setDismissedKeys(prev => {
                      const next = new Set([...prev, ...allKeys]);
                      try { sessionStorage.setItem('pnthr_ibkr_dismissed', JSON.stringify([...next])); } catch { /* */ }
                      return next;
                    });
                  }}
                  style={{ marginLeft: 'auto', background: 'none', border: '1px solid #333', color: '#666', borderRadius: 4, padding: '2px 10px', fontSize: 10, cursor: 'pointer' }}
                >
                  DISMISS ALL
                </button>
              </div>
            )}
            {visibleDiscrepancies.map(d => {
              const key = `${d.type}:${d.ticker}`;
              return (
                <IbkrDiscrepancyBanner
                  key={key}
                  d={d}
                  onDismiss={() => dismissIbkrDiscrepancy(key)}
                  onNavigate={navigate}
                  onFixed={() => {
                    // Remove from list + re-poll discrepancies + refresh Command positions
                    dismissIbkrDiscrepancy(key);
                    setCommandRefreshKey(k => k + 1); // triggers CommandCenter refetch
                    fetchIbkrDiscrepancies()
                      .then(data => {
                        if (data.ibkrConnected) setIbkrDiscrepancies(data.discrepancies || []);
                      })
                      .catch(() => {});
                  }}
                />
              );
            })}
          </>
        )}

        <main className="main">

          {/* Scanner pages (Long / Short) */}
          {isScanner && (
            <>
              <div className="date-picker-container">
                <label htmlFor="date-select" className="date-label">View:</label>
                <select
                  id="date-select"
                  className="date-picker"
                  value={selectedDate ?? ''}
                  onChange={(e) => loadStocksByDate(e.target.value)}
                  disabled={loading}
                >
                  {selectedDate == null && <option value="">Loading...</option>}
                  <option value="current">Current Week (Live)</option>
                  {availableDates.map((ranking) => (
                    <option key={ranking.date} value={ranking.date}>
                      {formatDate(ranking.date)} - {ranking.dayOfWeek}
                    </option>
                  ))}
                </select>
                {selectedDate === 'current' && (
                  <button className="refresh-button" onClick={() => loadCurrentStocks(true)} disabled={loading}>
                    {loading ? '🔄 Loading...' : '🔄 Refresh Data'}
                  </button>
                )}
              </div>

              {loading && (
                <div className="loading">
                  <div className="spinner"></div>
                  <p>{selectedDate === 'current' ? 'Fetching live data...' : 'Loading...'}</p>
                  {selectedDate === 'current' && <p className="loading-note">This may take a few moments</p>}
                </div>
              )}

              {error && (
                <div className="error">
                  <span className="error-icon">⚠️</span>
                  <p>{error}</p>
                  <button className="retry-button" onClick={() => loadCurrentStocks(true)}>
                    Try Again
                  </button>
                </div>
              )}

              {!loading && !error && stocks.length > 0 && (
                <>
                  {selectedDate !== 'current' && (
                    <div className="viewing-indicator">
                      📅 Viewing historical data from {formatDate(selectedDate)}
                    </div>
                  )}
                  <FilterBar stocks={stocks} signals={signals} filters={filters} onChange={setFilters} scanType={scanType} />
                  <StockTable key={activePage} stocks={filteredStocks} signals={signals} laserSignals={laserSignals} signalsLoading={signalsLoading} earnings={earnings} onTickerClick={handleRowClick} scanType={scanType} />
                </>
              )}
            </>
          )}

          {/* Search page */}
          {activePage === 'search' && <SearchPage />}

          {/* Sectors page */}
          {activePage === 'sectors' && <SectorPage />}

          {/* Watchlist page */}
          {activePage === 'watchlist' && <WatchlistPage />}

          {/* EMA Crossover page */}
          {activePage === 'ema' && <EmaCrossoverPage />}

          {/* ETF Scan page */}
          {activePage === 'etf' && <EtfPage />}

          {/* PNTHR Calendar page */}
          {activePage === 'earnings' && <CalendarPage />}

          {/* PNTHR APEX page */}
          {activePage === 'apex' && <ApexPage />}

          {/* PNTHR PREY page */}
          {activePage === 'prey' && <PreyPage onNavigate={navigate} />}

          {/* PNTHR Assistant — Daily Task Co-Pilot */}
          {activePage === 'assistant' && <AssistantPage onNavigate={navigate} />}

          {/* PNTHR's Pulse mission control */}
          {activePage === 'pulse' && <PulsePage onNavigate={navigate} />}

          {/* PNTHR's Perch newsletter */}
          {activePage === 'perch' && <NewsPage />}

          {/* Jungle page */}
          {activePage === 'jungle' && <JunglePage />}

          {/* PNTHR Command Center */}
          {activePage === 'command' && <CommandCenter onNavigate={navigate} refreshSignal={commandRefreshKey} />}

          {/* PNTHR Journal */}
          {activePage === 'journal' && <JournalPage onNavigate={navigate} initialFilter={journalInitFilter} focusPositionId={journalFocusId} focusTicker={journalFocusTicker} />}

          {/* Portfolio page */}
          {activePage === 'portfolio' && <PortfolioPage currentUser={currentUser} onProfileUpdate={setCurrentUser} />}

          {/* PNTHR Kill History — admin only */}
          {activePage === 'history' && (isAdmin
            ? <HistoryPage />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted to admins.</div>
          )}

          {/* PNTHR Kill Test — admin only */}
          {activePage === 'kill-test' && (isAdmin
            ? <KillTestPage />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted to admins.</div>
          )}

          {/* Signal History — admin only */}
          {activePage === 'signal-history' && (isAdmin
            ? <SignalHistoryPage />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted to admins.</div>
          )}
        </main>

        <footer className="footer">
          <p>Data provided by Financial Modeling Prep • Live view cached for 5 minutes</p>
        </footer>
      </div>

      {/* Chart Modal */}
      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={signals}
          earnings={earnings}
          onClose={() => setChartIndex(null)}
        />
      )}

      {/* Floating queue counter — visible on all pages */}
      {isAuthenticated && queueSize > 0 && !showQueuePanel && (
        <div
          onClick={() => setShowQueuePanel(true)}
          style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 200,
            background: '#FFD700', color: '#000', fontWeight: 800, fontSize: 12,
            padding: '10px 18px', borderRadius: 24, cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(255,215,0,0.4)', letterSpacing: '0.05em',
            userSelect: 'none' }}>
          ⚡ QUEUE ({queueSize}) — REVIEW →
        </div>
      )}

      {/* Send success toast */}
      {sendSuccess && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 200,
          background: '#28a745', color: '#fff', fontWeight: 700, fontSize: 12,
          padding: '10px 18px', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
          ✓ Entries sent to Command!
        </div>
      )}

      {/* Queue review panel */}
      {showQueuePanel && isAuthenticated && (
        <QueueReviewPanel onClose={() => setShowQueuePanel(false)} />
      )}
    </div>
  );
}

export default App;
