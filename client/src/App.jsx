import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AuthContext } from './AuthContext';
import { QueueProvider, useQueue } from './contexts/QueueContext';
import { AnalyzeProvider } from './contexts/AnalyzeContext';
import { DemoProvider } from './contexts/DemoContext';
import { PortalProvider, usePortal } from './contexts/PortalContext';
import { AumShieldProvider } from './contexts/AumShieldContext';
import AumShield from './components/AumShield';
import { FundProvider, useFund } from './contexts/FundContext';
import {
  ImpersonationProvider,
  useImpersonation,
  consumeImpersonationFromUrl,
  getImpersonationToken,
} from './contexts/ImpersonationContext';
import ImpersonationBanner, { IMPERSONATION_BANNER_HEIGHT } from './components/ImpersonationBanner';
import PageHeader from './components/PageHeader';
import QueueReviewPanel from './components/QueueReviewPanel';
import InvestorLoginPage from './components/InvestorLoginPage';
import InvestmentAmountModal from './components/InvestmentAmountModal';
import InvestorWelcomeModal from './components/InvestorWelcomeModal';
import SplashScreen from './components/SplashScreen';
import StockTable from './components/StockTable';
import AiTickerChartModal from './components/AiTickerChartModal';
import FilterBar from './components/FilterBar';
import Sidebar from './components/Sidebar';
import SectorPage from './components/SectorPage';
import WatchlistPage from './components/WatchlistPage';
import PortfolioPage from './components/PortfolioPage';
import EmaCrossoverPage from './components/EmaCrossoverPage';
import EtfPage from './components/EtfPage';
import CalendarPage from './components/CalendarPage';
import JunglePage from './components/JunglePage';
import AiJunglePage from './components/AiJunglePage';
import Ai300IndexPage from './components/Ai300IndexPage';
import BondHeatPage from './components/BondHeatPage';
import AiHeatPage from './components/AiHeatPage';
import JungleHeatPage from './components/JungleHeatPage';
import AiSectorsPage from './components/AiSectorsPage';
import AiOrdersPage from './components/AiOrdersPage';
import AmbushPage from './components/AmbushPage';
import AiKillPage from './components/AiKillPage';
import SearchPage from './components/SearchPage';
import PreyPage from './components/PreyPage';
import ApexPage from './components/ApexPage';
import JournalPage from './components/JournalPage';
import NewsPage from './components/NewsPage';
import PulsePage from './components/PulsePage';
import SignalHistoryPage from './components/SignalHistoryPage';
import AiSignalHistoryPage from './components/AiSignalHistoryPage';
import { useEventTracker } from './hooks/useEventTracker';
import { getSectorEmaPeriod } from './utils/sectorEmaConfig';
import { getAiAwareEmaPeriod } from './utils/aiUniverseEma';
import HistoryPage from './components/HistoryPage';
import KillTestPage from './components/KillTestPage';
import IrLivePage from './components/IrLivePage';
import TestPage from './components/TestPage';
import TrendlineAlertBanner, { TRENDLINE_BANNER_HEIGHT } from './components/TrendlineAlertBanner';
import MoversAlertBanner, { MOVERS_BANNER_HEIGHT } from './components/MoversAlertBanner';
import AmbushDiscrepancyBanner from './components/AmbushDiscrepancyBanner';
import NowOrdersBanner, { NOW_BANNER_HEIGHT } from './components/NowOrdersBanner';
import ReentryBanner from './components/ReentryBanner';
import AssistantPage from './components/AssistantPage';
import OrdersPage from './components/OrdersPage';
import LoginPage from './components/LoginPage';
import DataRoomPage from './components/DataRoomPage';
import CompliancePage from './components/CompliancePage';
import InvestorManagementPage from './components/InvestorManagementPage';
import { fetchTopStocks, fetchShortStocks, fetchAiTopStocks, fetchAiShortStocks, fetchAvailableDates, fetchRankingByDate, fetchSignals, fetchLaserSignals, fetchEarnings, fetchUserProfile, fetchInvestorProfile, fetchIbkrDiscrepancies, fetchHourlyEma, setAuthToken, clearAuthToken, setOnUnauthorized, authHeaders, API_BASE } from './services/api';
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
  // Consume ?impersonate=<jwt> from the URL into sessionStorage BEFORE any
  // token is read. Safe to call multiple times — it's a no-op after the URL
  // param is cleared on the first pass.
  consumeImpersonationFromUrl();
  return (
    <PortalProvider>
      <ImpersonationProvider>
        <ImpersonationBanner />
        <AppAuth />
      </ImpersonationProvider>
    </PortalProvider>
  );
}

function AppAuth() {
  const { portalMode, isInvestorPortal, isDenPortal, isVipPortal } = usePortal();
  // Impersonation token (sessionStorage, per-tab) wins over the admin's own
  // token (localStorage) whenever this tab is in a preview session. That
  // keeps the admin's main tab working as admin in parallel.
  const [authToken, setAuthTokenState] = useState(() => getImpersonationToken() || localStorage.getItem('pnthr_token'));
  const [currentUser, setCurrentUser] = useState(null); // { email, role, accountSize, defaultPage }
  const [authLoading, setAuthLoading] = useState(true);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showSplash, setShowSplash] = useState(false);

  // On mount: validate stored token + register 401 interceptor for expired sessions
  useEffect(() => {
    // Any API call that gets a 401 will trigger this — clears session and shows login
    setOnUnauthorized(() => {
      // Clear BOTH admin (localStorage) and impersonation (sessionStorage)
      // tokens. If an impersonation token expires mid-session the 401
      // handler runs here — clearing it drops the banner too.
      localStorage.removeItem('pnthr_token');
      try { window.sessionStorage.removeItem('pnthr_impersonation_token'); } catch { /* ignore */ }
      clearAuthToken();
      setAuthTokenState(null);
      setCurrentUser(null);
    });

    // Check for admin preview token in URL (from "Preview as Investor" button)
    const urlParams = new URLSearchParams(window.location.search);
    const previewToken = urlParams.get('preview_token');
    if (previewToken) {
      window.sessionStorage.setItem('pnthr_preview_token', previewToken);
      urlParams.delete('preview_token');
      window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
    }

    const token = window.sessionStorage.getItem('pnthr_preview_token') || getImpersonationToken() || localStorage.getItem('pnthr_token');
    if (!token) { setAuthLoading(false); return; }
    setAuthToken(token);

    // Investor tokens use a different profile endpoint.
    // However, if an admin is previewing via ?portal=investor, their regular
    // JWT should still go through the normal profile endpoint.
    const isPreviewSession = !!window.sessionStorage.getItem('pnthr_preview_token');
    const profileFetch = (isInvestorPortal || isVipPortal || isPreviewSession)
      ? fetchInvestorProfile().then(p => ({ ...p, role: 'investor' })).catch(() => fetchUserProfile())
      : fetchUserProfile();

    profileFetch
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
    localStorage.setItem('activeFund', 'ai');
    window.dispatchEvent(new Event('pnthr-fund-change'));
    // For investors, use investmentAmount as accountSize
    const acctSize = role === 'investor'
      ? (profile?.investmentAmount ?? null)
      : (profile?.accountSize ?? null);
    localStorage.setItem('pnthr_page', 'ai-ir-live');
    setCurrentUser({ email, role, accountSize: acctSize, defaultPage: 'ai-ir-live', name: profile?.name ?? null, company: profile?.company ?? null, investmentAmount: profile?.investmentAmount ?? null, loginCount: profile?.loginCount ?? null, maxLogins: profile?.maxLogins ?? 5, allowedPages: profile?.allowedPages ?? null });
    setShowSplash(true);
    if (role === 'investor') setShowWelcome(true);
  }

  function handleLogout() {
    localStorage.removeItem('pnthr_token');
    localStorage.removeItem('pnthr_page');
    try { sessionStorage.removeItem('pnthr.aumShield.unlockedUntil'); } catch {}
    clearAuthToken();
    setAuthTokenState(null);
    setCurrentUser(null);
  }

  // useCallback must be declared before any conditional returns (Rules of Hooks)
  const updateCurrentUser = useCallback((updates) => {
    setCurrentUser(prev => ({ ...prev, ...updates }));
  }, []); // setCurrentUser is stable from useState — no deps needed

  if (authLoading) return null; // brief flash while validating token

  // Show appropriate login page based on portal mode
  if (!authToken) {
    if (isInvestorPortal || isVipPortal) return <InvestorLoginPage onLogin={handleLogin} tryBothAuth={isVipPortal} />;
    return <LoginPage onLogin={handleLogin} />;
  }

  const isAdmin = currentUser?.role === 'admin';
  const isInvestor = currentUser?.role === 'investor';
  const needsAmountSelection = isInvestor && !currentUser?.investmentAmount;

  function handleAmountSaved(amount) {
    setCurrentUser(prev => ({ ...prev, investmentAmount: amount, accountSize: amount }));
  }

  return (
    <AuthContext.Provider value={{ currentUser, isAdmin, isInvestor, portalMode, updateCurrentUser }}>
      <AumShieldProvider>
      <FundProvider>
      <DemoProvider>
        <AnalyzeProvider>
          <QueueProvider>
            {showSplash && (
              <SplashScreen onComplete={() => setShowSplash(false)} />
            )}
            {!showSplash && showWelcome && isInvestor && (
              <InvestorWelcomeModal
                loginCount={currentUser?.loginCount}
                maxLogins={currentUser?.maxLogins}
                onClose={() => setShowWelcome(false)}
              />
            )}
            {!showSplash && !showWelcome && needsAmountSelection && (
              <InvestmentAmountModal
                currentAmount={currentUser?.investmentAmount}
                onSaved={handleAmountSaved}
              />
            )}
            <AppInner currentUser={currentUser} setCurrentUser={setCurrentUser} onLogout={handleLogout} />
          </QueueProvider>
        </AnalyzeProvider>
      </DemoProvider>
      </FundProvider>
      </AumShieldProvider>
    </AuthContext.Provider>
  );
}

// ── IBKR Discrepancy Banner ───────────────────────────────────────────────────
// Interactive 2-step fix flow for each discrepancy type.
// States: default → confirming → fixing → fixed (auto-dismiss)

// CRITICAL → dark red bg, white text | HIGH → PNTHR yellow bg, black text | MEDIUM → amber bg, black text
// INFO → teal bg (pyramid add-on triggers — strategy-as-designed, informational)
const DISC_BAND = {
  CRITICAL: { bg: '#7f0000', text: '#fff', muted: 'rgba(255,255,255,0.75)', tickerBg: 'rgba(0,0,0,0.30)', tickerText: '#fff', typeLbl: 'rgba(255,255,255,0.50)', icon: '🚨', onDark: true },
  HIGH:     { bg: '#fcf000', text: '#000', muted: 'rgba(0,0,0,0.60)',       tickerBg: 'rgba(0,0,0,0.12)', tickerText: '#000', typeLbl: 'rgba(0,0,0,0.45)',         icon: '⚠️', onDark: false },
  MEDIUM:   { bg: '#f9a825', text: '#000', muted: 'rgba(0,0,0,0.60)',       tickerBg: 'rgba(0,0,0,0.12)', tickerText: '#000', typeLbl: 'rgba(0,0,0,0.45)',         icon: 'ℹ️', onDark: false },
  INFO:     { bg: '#006064', text: '#fff', muted: 'rgba(255,255,255,0.75)', tickerBg: 'rgba(0,0,0,0.30)', tickerText: '#fff', typeLbl: 'rgba(255,255,255,0.50)', icon: '🔺', onDark: true },
};

function IbkrDiscrepancyBanner({ d, onDismiss, onFixed, onNavigate }) {
  const [uiState,     setUiState]     = useState('default');    // default | confirming | fixing | fixed
  const [chosen,      setChosen]      = useState(null);         // 'ibkr' | 'assistant'
  const [createState, setCreateState] = useState('idle');       // idle | confirming | creating | created | error
  const [createError, setCreateError] = useState('');            // server-side error message when createState='error'
  const [closeState,  setCloseState]  = useState('idle');       // idle | confirming | closing | closed | error

  const band = DISC_BAND[d.severity] || DISC_BAND.MEDIUM;
  const { bg, text, muted, tickerBg, tickerText, typeLbl, icon, onDark } = band;

  // ── Auto-fix: IBKR is source of truth for stops, shares, and avg cost ─────
  const autoFixedRef = useRef(false);
  useEffect(() => {
    if (!d.positionId || autoFixedRef.current) return;
    let fixFields = null;
    if (d.type === 'STOP_MISMATCH' && d.ibkrStop) {
      fixFields = { stopPrice: +d.ibkrStop };
    } else if (d.type === 'STOP_MISSING' && d.ibkrStop) {
      fixFields = { stopPrice: +d.ibkrStop };
    } else if (d.type === 'SHARES_MISMATCH' && d.ibkrShares != null) {
      fixFields = { remainingShares: d.ibkrShares };
    } else if (d.type === 'PRICE_MISMATCH' && d.ibkrAvg != null) {
      fixFields = { manualAvgCost: d.ibkrAvg };
    }
    if (!fixFields) return;
    autoFixedRef.current = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/positions`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: d.positionId, ...fixFields }),
        });
        if (res.ok) onFixed();
      } catch {}
    })();
  }, [d]);

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
    if (uiState === 'fixing')  return <span style={{ color: muted, fontSize: 11 }}>Saving…</span>;
    if (uiState === 'fixed')   return <span style={{ color: text, fontWeight: 700, fontSize: 11 }}>✓ Fixed! PNTHR updated.</span>;

    const dirLabel = d.direction === 'SHORT' ? 'SHORT' : 'LONG';

    // ── CONFIRMING step ────────────────────────────────────────────────────
    if (uiState === 'confirming') {
      let confirmText = '';
      let fixFields   = {};
      if (d.type === 'SHARES_MISMATCH') {
        confirmText = `Fix PNTHR: set ${d.ticker} to ${chosen === 'ibkr' ? d.ibkrShares : d.pnthrShares} shares?`;
        fixFields   = { remainingShares: chosen === 'ibkr' ? d.ibkrShares : d.pnthrShares };
      } else if (d.type === 'PRICE_MISMATCH') {
        confirmText = `Fix PNTHR avg cost for ${d.ticker} to $${chosen === 'ibkr' ? d.ibkrAvg.toFixed(2) : d.pnthrAvg.toFixed(2)}?`;
        fixFields   = { manualAvgCost: chosen === 'ibkr' ? d.ibkrAvg : d.pnthrAvg };
      } else if (d.type === 'STOP_MISSING' || d.type === 'STOP_MISMATCH') {
        const newStop = chosen === 'ibkr' ? d.ibkrStop : d.pnthrStop;
        confirmText   = `Set ${d.ticker} stop to $${(+newStop).toFixed(2)} in PNTHR Assistant?`;
        fixFields     = { stopPrice: +newStop };
      }
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: text, fontSize: 11 }}>{confirmText}</span>
          <button onClick={() => applyFix(fixFields)} style={btnStyle('primary')}>✓ YES – FIX IT</button>
          <button onClick={() => { setUiState('default'); setChosen(null); }} style={btnStyle('secondary')}>✗ NO, CANCEL</button>
        </span>
      );
    }

    // ── DEFAULT step — show discrepancy + choice buttons ──────────────────
    if (d.type === 'SHARES_MISMATCH') {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: muted, fontSize: 11 }}>
            {dirLabel} · <b style={{ color: text }}>{Math.abs(d.diff)}</b> share diff — which count is correct?
          </span>
          <button onClick={() => { setChosen('assistant'); setUiState('confirming'); }} style={btnStyle('secondary')}>
            PNTHR: {d.pnthrShares} shr
          </button>
          <button onClick={() => { setChosen('ibkr'); setUiState('confirming'); }} style={btnStyle('primary')}>
            IBKR: {d.ibkrShares} shr ← use this
          </button>
        </span>
      );
    }
    if (d.type === 'PRICE_MISMATCH') {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: muted, fontSize: 11 }}>
            Avg cost <b style={{ color: text }}>{d.diffPct}%</b> off — which is correct?
          </span>
          <button onClick={() => { setChosen('assistant'); setUiState('confirming'); }} style={btnStyle('secondary')}>
            PNTHR: ${d.pnthrAvg?.toFixed(2)}
          </button>
          <button onClick={() => { setChosen('ibkr'); setUiState('confirming'); }} style={btnStyle('primary')}>
            IBKR: ${d.ibkrAvg?.toFixed(2)} ← use this
          </button>
        </span>
      );
    }
    if (d.type === 'STOP_MISSING') {
      if (d.ibkrStop) {
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: muted, fontSize: 11 }}>No stop set! IBKR has a stop order at <b style={{ color: text }}>${(+d.ibkrStop).toFixed(2)}</b></span>
            <button onClick={() => { setChosen('ibkr'); setUiState('confirming'); }} style={btnStyle('primary')}>
              Use IBKR stop: ${(+d.ibkrStop).toFixed(2)}
            </button>
            <button onClick={() => onNavigate('assistant')} style={btnStyle('secondary')}>Set manually in Assistant →</button>
          </span>
        );
      }
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: muted, fontSize: 11 }}>No stop in PNTHR Assistant or IBKR — position is UNPROTECTED</span>
          <button onClick={() => onNavigate('assistant')} style={btnStyle('primary')}>Set Stop in PNTHR Assistant →</button>
        </span>
      );
    }
    if (d.type === 'STOP_MISMATCH') {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: muted, fontSize: 11 }}>Stop prices differ — which is correct?</span>
          <button onClick={() => { setChosen('assistant'); setUiState('confirming'); }} style={btnStyle('secondary')}>
            PNTHR: ${(+d.pnthrStop).toFixed(2)}
          </button>
          <button onClick={() => { setChosen('ibkr'); setUiState('confirming'); }} style={btnStyle('primary')}>
            IBKR: ${(+d.ibkrStop).toFixed(2)} ← use this
          </button>
        </span>
      );
    }
    if (d.type === 'TICKER_MISSING') {
      const isCmdOnly = d.side === 'COMMAND_ONLY';

      // ── COMMAND_ONLY: position in PNTHR Assistant but not (or 0) in IBKR ─────────
      if (isCmdOnly) {
        const desc = d.ibkrShowsZero
          ? `In PNTHR (${d.pnthrShares} shr) — IBKR now shows 0 shares (closed there)`
          : `In PNTHR (${d.pnthrShares} shr) — not found in IBKR at all`;

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

        if (closeState === 'closing') return <span style={{ color: muted, fontSize: 11 }}>Closing…</span>;
        if (closeState === 'closed')  return <span style={{ color: text, fontWeight: 700, fontSize: 11 }}>✓ Closed in PNTHR Assistant.</span>;
        if (closeState === 'error')   return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: muted, fontSize: 11 }}>Close failed — try manually in PNTHR Assistant</span>
            <button onClick={() => onNavigate('assistant')} style={btnStyle('secondary')}>Open PNTHR Assistant →</button>
          </span>
        );

        if (closeState === 'confirming') return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: muted, fontSize: 11 }}>
              Close <b style={{ color: text }}>{d.ticker}</b> at <b style={{ color: text }}>${d.ibkrExitPrice?.toFixed(2)}</b> (from IBKR)?
            </span>
            <button onClick={doClose} style={btnStyle('danger')}>✓ YES – CLOSE IT</button>
            <button onClick={() => setCloseState('idle')} style={btnStyle('secondary')}>✗ CANCEL</button>
          </span>
        );

        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: muted, fontSize: 11 }}>{desc}</span>
            {d.ibkrExitPrice
              ? <button onClick={() => setCloseState('confirming')} style={btnStyle('primary')}>Close in PNTHR Assistant →</button>
              : <button onClick={() => onNavigate('assistant')} style={btnStyle('primary')}>Close in PNTHR Assistant →</button>
            }
          </span>
        );
      }

      // ── IBKR_ONLY: position in IBKR but missing from PNTHR ─────────────
      async function doCreate() {
        setCreateState('creating');
        setCreateError('');
        try {
          const res = await fetch(`${API_BASE}/api/ibkr/import-position`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: d.ticker }),
          });
          if (!res.ok) {
            // Surface the server's specific error so the user can act on it
            // (already-active position, ticker not in current snapshot, etc.)
            // instead of seeing a generic "Create failed".
            let msg = `HTTP ${res.status}`;
            try {
              const body = await res.json();
              if (body?.error) msg = body.error;
            } catch { /* response wasn't JSON; keep HTTP code */ }
            throw new Error(msg);
          }
          setCreateState('created');
          setTimeout(() => onFixed(), 2000);
        } catch (e) {
          setCreateError(e.message || 'unknown error');
          setCreateState('error');
        }
      }

      const dirLabel = d.ibkrDirection || 'LONG';
      const costStr  = d.ibkrAvgCost ? ` @ $${(+d.ibkrAvgCost).toFixed(2)}` : '';
      const staleNote = d.syncIsStale ? `  ⏱ ${d.staleMins}m old` : '';

      if (createState === 'confirming') {
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: muted, fontSize: 11 }}>
              Create <b style={{ color: text }}>{dirLabel}</b> card for <b style={{ color: text }}>{d.ticker}</b> — {d.ibkrShares} shr{costStr} — Lot 1 + PNTHR stop pre-filled. Expand lots after.
            </span>
            <button onClick={doCreate} style={btnStyle('primary')}>✓ YES – CREATE IT</button>
            <button onClick={() => setCreateState('idle')} style={btnStyle('secondary')}>✗ CANCEL</button>
          </span>
        );
      }
      if (createState === 'creating') return <span style={{ color: muted, fontSize: 11 }}>Creating position in PNTHR Assistant…</span>;
      if (createState === 'created')  return <span style={{ color: text, fontWeight: 700, fontSize: 11 }}>✓ Position created! Go to PNTHR Assistant to set stop + expand lots.</span>;
      if (createState === 'error') {
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: muted, fontSize: 11 }}>
              Create failed: <b style={{ color: text }}>{createError || 'unknown error'}</b>
            </span>
            <button onClick={() => setCreateState('confirming')} style={btnStyle('danger')}>Retry</button>
            <button onClick={() => onNavigate('assistant')} style={btnStyle('secondary')}>Open Assistant →</button>
          </span>
        );
      }

      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: muted, fontSize: 11 }}>
            In IBKR — {dirLabel} {d.ibkrShares} shr{costStr} — NOT in PNTHR Assistant{staleNote}
          </span>
          <button onClick={() => setCreateState('confirming')} style={btnStyle('primary')}>
            Create in PNTHR Assistant →
          </button>
        </span>
      );
    }
    if (d.type === 'PYRAMID_TRIGGER') {
      const breakWord = dirLabel === 'LONG' ? 'above' : 'below';
      return (
        <span style={{ color: muted, fontSize: 11 }}>
          {dirLabel} · Pre-placed pyramid trigger: IBKR {d.ibkrAction} {d.ibkrOrderType} @ <b style={{ color: text }}>${(+d.ibkrStop).toFixed(2)}</b> — fires if price breaks {breakWord} trigger (not a stop-loss).
        </span>
      );
    }
    return null;
  }

  // Button styles that contrast against the band background
  function btnStyle(variant) {
    if (onDark) {
      // Dark background (CRITICAL red) — light buttons
      if (variant === 'primary')   return { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.5)', color: '#fff', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 };
      if (variant === 'secondary') return { background: 'none', border: '1px solid rgba(255,255,255,0.25)', color: 'rgba(255,255,255,0.65)', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 };
      if (variant === 'danger')    return { background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.4)', color: '#fff', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 };
    } else {
      // Light background (HIGH yellow / MEDIUM amber) — dark buttons
      if (variant === 'primary')   return { background: '#1a1a1a', border: '1px solid #1a1a1a', color: '#fff', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 };
      if (variant === 'secondary') return { background: 'rgba(0,0,0,0.12)', border: '1px solid rgba(0,0,0,0.30)', color: '#000', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 };
      if (variant === 'danger')    return { background: '#7f0000', border: '1px solid #7f0000', color: '#fff', borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 };
    }
    return {};
  }

  return (
    <div style={{
      background: bg,
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
      <span style={{ color: text, fontWeight: 800, flexShrink: 0, fontSize: 10, letterSpacing: '0.06em', minWidth: 56 }}>
        {d.severity}
      </span>

      {/* Ticker — prominent */}
      <span style={{
        fontWeight: 900, fontSize: 13, color: tickerText,
        background: tickerBg, borderRadius: 4,
        padding: '1px 7px', flexShrink: 0, letterSpacing: '0.04em',
      }}>
        {d.ticker}
      </span>

      {/* Type label */}
      <span style={{ fontSize: 10, color: typeLbl, flexShrink: 0, letterSpacing: '0.04em' }}>
        {d.type === 'PYRAMID_TRIGGER' ? 'PYRAMID' : d.type.replace(/_/g, ' ')}
      </span>

      {/* Interactive content */}
      <span style={{ flex: 1 }}>{renderContent()}</span>

      {/* Dismiss button */}
      {uiState === 'default' && (
        <button
          onClick={e => { e.stopPropagation(); onDismiss(); }}
          style={{ background: 'none', border: `1px solid ${onDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'}`, color: muted, borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}
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
  // Used only to shift page content below the fixed impersonation banner.
  // `isImpersonating` must be read here — it's not in scope from AppAuth.
  const { isImpersonating } = useImpersonation();
  const { isAuthenticated, queueSize, showQueuePanel, setShowQueuePanel, sendSuccess } = useQueue();
  const { activeFund } = useFund();
  const isAdmin = currentUser?.role === 'admin';
  const isInvestor = currentUser?.role === 'investor';
  const [trendlineBannerVisible, setTrendlineBannerVisible] = useState(false);
  const [moversBannerVisible, setMoversBannerVisible] = useState(false);
  const [nowOrdersBannerVisible, setNowOrdersBannerVisible] = useState(false);
  const [reentryBannerHeight, setReentryBannerHeight] = useState(0);
  const [discBannerHeight, setDiscBannerHeight] = useState(0);
  const [lotAlerts,         setLotAlerts]         = useState([]);
  const [dismissedLotKeys,  setDismissedLotKeys]  = useState(new Set());
  const [positions,         setPositions]         = useState([]); // full positions for EMA alerts

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
  const [closedTodayMap, setClosedTodayMap] = useState({}); // { [TICKER]: { direction, exitPrice, exitReason, closedAt } }

  useEffect(() => {
    if (!isAuthenticated) { setEmaValues({}); setClosedTodayMap({}); return; }
    const load = async () => {
      try {
        const data = await fetchHourlyEma();
        setEmaValues(data.ema || data); // backwards-compat: old shape was flat object
        setClosedTodayMap(data.closedToday || {});
      } catch { /* non-fatal */ }
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
      const rawEma  = +emaData.ema21h;
      // Project EMA forward using current price (what EMA would be if this bar closed now)
      const emaPeriod = getAiAwareEmaPeriod(ticker) || getSectorEmaPeriod(p.sector);
      const k       = 2 / (emaPeriod + 1); // EMA multiplier
      const ema21h  = +(price * k + rawEma * (1 - k)).toFixed(4);
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
  const visibleLotAlerts = lotAlerts.filter(a => !dismissedLotKeys.has(`${a.ticker}-${a.lot}`));

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

  // ── Friday Run-Preview Banner ──────────────────────────────────────────────
  // Shows on ALL pages for admins on Fridays between 10:30am–4:00pm AZ (MST/UTC-7).
  // Dismissed per-session via sessionStorage so it doesn't reappear until next reload.
  const [fridayBannerDismissed, setFridayBannerDismissed] = useState(
    () => sessionStorage.getItem('pnthr_friday_banner_dismissed') === 'true'
  );
  const showFridayBanner = isAdmin && !fridayBannerDismissed && (() => {
    const now = new Date();
    const azOffset = -7 * 60; // AZ = MST = UTC-7 always (no DST)
    const utcMin = now.getTime() / 60000 + now.getTimezoneOffset();
    const azMin = utcMin + azOffset;
    const azDate = new Date((azMin + 7 * 60) * 60000); // reconstruct to get day
    const azNow = new Date(now.getTime() + (azOffset - (-now.getTimezoneOffset())) * 60000);
    const dow = azNow.getDay(); // 0=Sun … 5=Fri
    const hour = azNow.getHours();
    const min = azNow.getMinutes();
    const azMinOfDay = hour * 60 + min;
    return dow === 5 && azMinOfDay >= 630 && azMinOfDay < 960; // 10:30am–4:00pm AZ
  })();

  function dismissFridayBanner() {
    sessionStorage.setItem('pnthr_friday_banner_dismissed', 'true');
    setFridayBannerDismissed(true);
  }

  const { allowedPages: portalAllowed } = usePortal();
  // Per-user allowedPages (from DB) takes precedence over hardcoded portal defaults
  const userPages = currentUser?.allowedPages;
  const rawAllowed = (userPages && userPages.length > 0) ? userPages : portalAllowed;
  // AI variant pages (e.g. 'ai-ir-live') should be allowed whenever the base key ('ir-live') is
  const effectiveAllowed = useMemo(() => {
    if (!rawAllowed) return null;
    const map = {
      'ai-ir-live': 'ir-live', 'ambush-ir-live': 'ir-live', 'ai-data-room': 'data-room', 'aiPulse': 'pulse',
      'aiOrders': 'orders', 'aiKill': 'apex', 'aiJungle': 'jungle',
      'aiSectors': 'sectors', 'aiHeat': 'jungleHeat', 'ai-signal-history': 'signal-history',
    };
    const expanded = new Set(rawAllowed);
    for (const [ai, base] of Object.entries(map)) {
      if (expanded.has(base)) expanded.add(ai);
    }
    return [...expanded];
  }, [rawAllowed]); // eslint-disable-line react-hooks/exhaustive-deps

  const [activePage, setActivePageRaw] = useState(() => {
    const saved = localStorage.getItem('pnthr_page');
    if (effectiveAllowed && saved && !effectiveAllowed.includes(saved)) return effectiveAllowed[0];
    return saved || currentUser?.defaultPage || 'long';
  });

  // Portal guard: redirect to first allowed page if current page isn't permitted
  useEffect(() => {
    if (effectiveAllowed && !effectiveAllowed.includes(activePage)) {
      setActivePageRaw(effectiveAllowed[0]);
    }
  }, [effectiveAllowed, activePage]);

  // ── Page history stack for back navigation ──────────────────────────────────
  const [pageHistory, setPageHistory] = useState([]);

  function setActivePage(page) {
    if (effectiveAllowed && !effectiveAllowed.includes(page)) return;
    setActivePageRaw(page);
  }

  // Synchronous portal override — never render a page the portal doesn't allow
  const renderPage = (effectiveAllowed && !effectiveAllowed.includes(activePage))
    ? effectiveAllowed[0]
    : activePage;

  // Portal analytics — track page views with duration for investor/VIP users
  const { trackPageView } = useEventTracker();
  useEffect(() => { trackPageView(renderPage); }, [renderPage, trackPageView]);

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
    // Push current page onto history stack before navigating (avoid duplicates)
    if (activePage && activePage !== page) {
      setPageHistory(prev => [...prev, activePage]);
    }
    setActivePage(page);
    localStorage.setItem('pnthr_page', page);
  }

  function navigateBack() {
    if (pageHistory.length === 0) return;
    const prev = pageHistory[pageHistory.length - 1];
    setPageHistory(s => s.slice(0, -1));
    setActivePageRaw(prev);
    localStorage.setItem('pnthr_page', prev);
  }

  const canGoBack = pageHistory.length > 0;
  const scanType = renderPage === 'short' ? 'short' : 'long';
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
  // AI 100 universe toggle — synced from global fund toggle
  const [scannerUniverse, setScannerUniverse] = useState(activeFund === 'ai' ? 'ai300' : '679');
  const [aiStocks, setAiStocks] = useState([]);
  const [aiSignals, setAiSignals] = useState({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiEarnings, setAiEarnings] = useState({});
  const [aiChartTickers, setAiChartTickers] = useState([]);
  const [aiChartIndex, setAiChartIndex] = useState(null);
  const [risingMode, setRisingMode] = useState(false);

  const isScanner = renderPage === 'long' || renderPage === 'short';
  const isAiScanner = isScanner && scannerUniverse === 'ai300';

  // Reset filters and rising mode when tab or date changes
  useEffect(() => {
    setFilters(defaultFilters);
    setRisingMode(false);
  }, [activePage, selectedDate]);

  useEffect(() => {
    switchScannerUniverse(activeFund === 'ai' ? 'ai300' : '679');
  }, [activeFund]); // eslint-disable-line react-hooks/exhaustive-deps

  function switchScannerUniverse(u) {
    setScannerUniverse(u);
    setRisingMode(false);
    sessionStorage.setItem('scannerUniverse', u);
    if (u === 'ai300') loadAiStocks();
  }

  async function loadAiStocks() {
    setAiLoading(true);
    setAiError(null);
    try {
      const fetchFn = scanType === 'short' ? fetchAiShortStocks : fetchAiTopStocks;
      const data = await fetchFn();
      setAiStocks(data);
      setAiSignals({});
      const tickers = data.map(s => s.ticker);
      const opts = { shortList: scanType === 'short' };
      Promise.all([
        fetchSignals(tickers, opts).catch(err => { console.error('AI signals error:', err); return {}; }),
        fetchLaserSignals(tickers, opts).catch(err => { console.error('AI laser signals error:', err); return {}; }),
      ]).then(([pnthr]) => {
        setAiSignals(pnthr);
      });
      fetchEarnings(tickers).then(result => setAiEarnings(result)).catch(() => {});
    } catch (err) {
      console.error('AI stocks fetch failed:', err);
      setAiError('Failed to load AI stock data.');
    } finally {
      setAiLoading(false);
    }
  }

  // Load AI stocks when switching to AI mode or changing long/short
  useEffect(() => {
    if (isScanner && scannerUniverse === 'ai300') loadAiStocks();
  }, [activePage, scannerUniverse]);

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

  // Rising 100: AI 300 only — filter to positive rank movers with active signals, sort by freshness then magnitude
  const risingStocks = useMemo(() => {
    const targetSignal = scanType === 'short' ? 'SS' : 'BL';
    const sourceStocks = aiStocks;
    const sourceSignals = aiSignals;

    return sourceStocks
      .filter(stock => {
        const rc = stock.rankChange;
        if (rc == null || rc <= 0) return false; // must be a positive rank mover
        const sig = sourceSignals[stock.ticker];
        if (!sig || sig.signal !== targetSignal) return false; // must have active BL (longs) or SS (shorts)
        return true;
      })
      .map(stock => {
        const sig = sourceSignals[stock.ticker];
        const wks = computeWeeksAgo(sig?.signalDate, sig?.lastBarDate) ?? 999;
        return { ...stock, _risingWeeks: wks, _risingRankChange: stock.rankChange };
      })
      .sort((a, b) => {
        // Primary: highest rank change (biggest mover first)
        if (a._risingRankChange !== b._risingRankChange) return b._risingRankChange - a._risingRankChange;
        // Secondary: lowest weeks-since (freshest signal first)
        return a._risingWeeks - b._risingWeeks;
      });
  }, [scanType, aiStocks, aiSignals]);

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
    if (isAiScanner) {
      setAiChartTickers(sortedStocks.map(s => s.ticker));
      setAiChartIndex(sortedIdx);
    } else {
      setChartStocks(sortedStocks);
      setChartIndex(sortedIdx);
    }
  }

  return (
    <div className="app" style={{
      paddingTop: isImpersonating
        ? IMPERSONATION_BANNER_HEIGHT
        : (trendlineBannerVisible ? TRENDLINE_BANNER_HEIGHT : 0)
          + (moversBannerVisible ? MOVERS_BANNER_HEIGHT : 0)
          + (nowOrdersBannerVisible ? NOW_BANNER_HEIGHT : 0)
          + reentryBannerHeight
          + discBannerHeight || undefined,
    }}>
      {isAuthenticated && !isImpersonating && (
        <TrendlineAlertBanner
          onNavigateToAssistant={() => navigate('assistant')}
          onVisibleChange={setTrendlineBannerVisible}
          onTickerClick={(ticker) => {
            setChartStocks([{ ticker }]);
            setChartIndex(0);
          }}
        />
      )}
      {isAuthenticated && !isImpersonating && <MoversAlertBanner
        topOffset={trendlineBannerVisible ? TRENDLINE_BANNER_HEIGHT : 0}
        onVisibleChange={setMoversBannerVisible}
        onTickerClick={(ticker) => {
          setChartStocks([{ ticker }]);
          setChartIndex(0);
        }}
      />}
      {isAuthenticated && !isImpersonating && <NowOrdersBanner
        topOffset={(trendlineBannerVisible ? TRENDLINE_BANNER_HEIGHT : 0)
          + (moversBannerVisible ? MOVERS_BANNER_HEIGHT : 0)}
        onVisibleChange={setNowOrdersBannerVisible}
        onNavigate={navigate}
        onTickerClick={(ticker) => {
          setChartStocks([{ ticker }]);
          setChartIndex(0);
        }}
      />}
      {isAuthenticated && !isImpersonating && <ReentryBanner
        topOffset={(trendlineBannerVisible ? TRENDLINE_BANNER_HEIGHT : 0)
          + (moversBannerVisible ? MOVERS_BANNER_HEIGHT : 0)
          + (nowOrdersBannerVisible ? NOW_BANNER_HEIGHT : 0)}
        onVisibleChange={(vis, h) => setReentryBannerHeight(vis ? (h || 0) : 0)}
        onTickerClick={(ticker) => {
          setChartStocks([{ ticker }]);
          setChartIndex(0);
        }}
      />}
      {isAuthenticated && !isImpersonating && <AmbushDiscrepancyBanner
        topOffset={(trendlineBannerVisible ? TRENDLINE_BANNER_HEIGHT : 0)
          + (moversBannerVisible ? MOVERS_BANNER_HEIGHT : 0)
          + (nowOrdersBannerVisible ? NOW_BANNER_HEIGHT : 0)
          + reentryBannerHeight}
        onLayout={setDiscBannerHeight}
      />}
      <Sidebar activePage={activePage} onNavigate={navigate} currentUser={currentUser} isAdmin={isAdmin} onLogout={onLogout} longStats={longBatchStats} shortStats={shortBatchStats} />

      {/* Floating back navigation button */}
      {canGoBack && (
        <button
          onClick={navigateBack}
          style={{
            position: 'fixed', bottom: 24, left: 230, zIndex: 1000,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'rgba(20,20,20,0.95)', border: '1px solid #444',
            borderRadius: 8, padding: '8px 16px 8px 12px',
            color: '#ccc', fontSize: 13, fontWeight: 700,
            cursor: 'pointer', fontFamily: 'inherit',
            backdropFilter: 'blur(10px)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            transition: 'color 0.15s, border-color 0.15s, background 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#FCF000'; e.currentTarget.style.borderColor = '#FCF000'; e.currentTarget.style.background = 'rgba(252,240,0,0.08)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = '#ccc'; e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.background = 'rgba(20,20,20,0.95)'; }}
          title="Go back to previous page"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back
        </button>
      )}

      <div className="content-wrapper">
        {/* Lot Ready banner — visible on all pages when a pyramid lot is triggered */}
        {isAuthenticated && !isImpersonating && visibleLotAlerts.length > 0 && (
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
              🎯 {visibleLotAlerts.length} LOT{visibleLotAlerts.length > 1 ? 'S' : ''} READY
            </span>
            {visibleLotAlerts.map((a, i) => (
              <span key={i} style={{ color: '#aaa' }}>
                <b style={{ color: '#fff' }}>{a.ticker}</b>
                {' '}Lot {a.lot} ({a.lotName}) — trigger ${a.trigger.toFixed(2)}
                {i < visibleLotAlerts.length - 1 ? <span style={{ color: '#444', margin: '0 6px' }}>|</span> : null}
              </span>
            ))}
            <button
              onClick={() => navigate('assistant')}
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
              GO TO ASSISTANT →
            </button>
            <button
              onClick={() => setDismissedLotKeys(prev => new Set([...prev, ...visibleLotAlerts.map(a => `${a.ticker}-${a.lot}`)]))}
              title="Dismiss until next session or until a new lot becomes ready"
              style={{
                background: 'none',
                border: '1px solid rgba(40,167,69,0.4)',
                color: 'rgba(255,255,255,0.7)',
                borderRadius: 4,
                padding: '4px 10px',
                fontWeight: 700,
                fontSize: 14,
                lineHeight: 1,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* ── 21H EMA Crossover Alerts — fires when price crosses 21H EMA on active positions ── */}
        {isAuthenticated && !isImpersonating && visibleEmaAlerts.length > 0 && (
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

        {/* ── IBKR Discrepancy Banners — admin-only (broker reconciliation tooling) ── */}
        {isAdmin && !isImpersonating && visibleDiscrepancies.length > 0 && (
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
            {visibleDiscrepancies.map((d, i) => {
              const dismissKey = `${d.type}:${d.ticker}`;
              const reactKey = `${dismissKey}:${d.ibkrStop || ''}:${i}`;
              return (
                <IbkrDiscrepancyBanner
                  key={reactKey}
                  d={d}
                  onDismiss={() => dismissIbkrDiscrepancy(dismissKey)}
                  onNavigate={navigate}
                  onFixed={() => {
                    dismissIbkrDiscrepancy(dismissKey);
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

        {/* ── Friday Run-Preview Banner — admin only, Fridays 10:30am–4pm AZ ── */}
        {showFridayBanner && (
          <div style={{
            background: 'linear-gradient(90deg, rgba(252,240,0,0.12), rgba(252,240,0,0.04))',
            borderBottom: '2px solid rgba(252,240,0,0.5)',
            padding: '10px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            fontSize: 13,
            flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 16 }}>📋</span>
            <span style={{ color: '#FCF000', fontWeight: 900, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
              FRIDAY ORDER SHEET
            </span>
            <span style={{ color: '#ccc', fontWeight: 400 }}>
              It's time to run the weekly PREVIEW on PNTHR Orders (11am AZ).
            </span>
            <button
              onClick={() => navigate('orders')}
              style={{
                background: '#FCF000',
                color: '#000',
                border: 'none',
                borderRadius: 4,
                padding: '5px 16px',
                fontWeight: 800,
                fontSize: 12,
                cursor: 'pointer',
                letterSpacing: '0.05em',
                whiteSpace: 'nowrap',
              }}
            >
              RUN PREVIEW NOW →
            </button>
            <button
              onClick={dismissFridayBanner}
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: '1px solid #555',
                color: '#888',
                borderRadius: 4,
                padding: '4px 12px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              DISMISS
            </button>
          </div>
        )}

        <main className="main">

          {/* Scanner pages (Long / Short) */}
          {isScanner && (
            <>
              <PageHeader title={scanType === 'short' ? 'PNTHR 100 Shorts' : 'PNTHR 100 Longs'} description="Top 100 ranked signals by strength across both fund universes." />
              {/* Universe toggle: Carnivore vs AI 300 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                {[
                  { key: '679', label: 'Carnivore' },
                  { key: 'ai300', label: 'PNTHR AI 300' },
                ].map(u => {
                  const active = scannerUniverse === u.key;
                  return (
                    <button key={u.key} onClick={() => switchScannerUniverse(u.key)} style={{
                      padding: '6px 16px', borderRadius: 6,
                      border: active ? '1px solid #FFD700' : '1px solid #333',
                      background: active ? 'rgba(255,215,0,0.12)' : '#111',
                      color: active ? '#FFD700' : '#666',
                      fontWeight: active ? 800 : 600, fontSize: 12,
                      fontFamily: 'monospace', letterSpacing: 1.5,
                      cursor: 'pointer', transition: 'all 0.15s',
                    }}>{u.label}</button>
                  );
                })}
                {scannerUniverse === 'ai300' && (
                  <button
                    onClick={() => setRisingMode(r => !r)}
                    style={{
                      padding: '6px 16px', borderRadius: 6,
                      border: risingMode ? '2px solid #00e676' : '2px solid #00c853',
                      background: risingMode ? 'rgba(0,230,118,0.15)' : 'rgba(0,200,83,0.06)',
                      color: risingMode ? '#00e676' : '#00c853',
                      fontWeight: 800, fontSize: 12,
                      fontFamily: 'monospace', letterSpacing: 1.5,
                      cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    {risingMode ? `Rising ${risingStocks.length}` : `Rising 100`}
                  </button>
                )}
                <span style={{ color: '#333', fontSize: 11, marginLeft: 6, fontFamily: 'monospace' }}>
                  {scanType === 'long' ? '100 LONGS' : '100 SHORTS'}
                </span>
              </div>

              {/* ── 679 Universe ── */}
              {scannerUniverse === '679' && <>
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
              </>}

              {/* ── AI 300 Universe ── */}
              {scannerUniverse === 'ai300' && <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <button className="refresh-button" onClick={loadAiStocks} disabled={aiLoading} style={{ fontSize: 12 }}>
                    {aiLoading ? '🔄 Loading...' : '🔄 Refresh AI Data'}
                  </button>
                  <span style={{ color: '#555', fontSize: 11, fontFamily: 'monospace' }}>
                    {aiStocks.length} AI {scanType === 'long' ? 'long' : 'short'} stocks ranked by YTD return
                  </span>
                </div>

                {aiLoading && (
                  <div className="loading">
                    <div className="spinner"></div>
                    <p>Loading AI {scanType === 'long' ? 'long' : 'short'} stocks...</p>
                  </div>
                )}

                {aiError && (
                  <div className="error">
                    <span className="error-icon">⚠️</span>
                    <p>{aiError}</p>
                    <button className="retry-button" onClick={loadAiStocks}>Try Again</button>
                  </div>
                )}

                {!aiLoading && !aiError && aiStocks.length > 0 && (
                  <StockTable key={risingMode ? `ai-rising-${activePage}` : `ai-${activePage}`} stocks={risingMode ? risingStocks : aiStocks} signals={aiSignals} laserSignals={{}} signalsLoading={false} earnings={aiEarnings} onTickerClick={handleRowClick} scanType={scanType} hideExchange defaultSort={risingMode ? { key: 'rankChange', direction: 'desc' } : null} />
                )}

                {!aiLoading && !aiError && aiStocks.length === 0 && (
                  <div style={{ color: '#555', fontSize: 13, fontFamily: 'monospace', padding: 20, textAlign: 'center' }}>
                    No AI stock data available yet.
                  </div>
                )}
              </>}
            </>
          )}

          {/* Search page */}
          {renderPage === 'search' && <SearchPage />}

          {/* Sectors page */}
          {renderPage === 'sectors' && <SectorPage />}

          {/* Watchlist page */}
          {renderPage === 'watchlist' && <WatchlistPage />}

          {/* EMA Crossover page */}
          {renderPage === 'ema' && <EmaCrossoverPage />}

          {/* ETF Scan page */}
          {renderPage === 'etf' && <EtfPage />}

          {/* PNTHR Calendar page */}
          {renderPage === 'earnings' && <CalendarPage />}

          {/* PNTHR APEX page */}
          {renderPage === 'apex' && <ApexPage />}

          {/* PNTHR Orders — weekly order sheet (PIN protected) */}
          {renderPage === 'orders' && <AumShield block showDuration><OrdersPage /></AumShield>}

          {/* PNTHR PREY page */}
          {renderPage === 'prey' && <PreyPage onNavigate={navigate} />}

          {/* PNTHR Assistant — Daily Task Co-Pilot */}
          {renderPage === 'assistant' && <AssistantPage onNavigate={navigate} />}

          {/* PNTHR's Pulse mission control */}
          {renderPage === 'pulse' && <PulsePage onNavigate={navigate} fund="carn" />}
          {renderPage === 'aiPulse' && <PulsePage onNavigate={navigate} fund="ai" />}

          {/* PNTHR AI 300 Index — standalone chart page */}
          {renderPage === 'ai300Index' && <Ai300IndexPage />}

          {/* PNTHR's Perch newsletter */}
          {renderPage === 'perch' && <NewsPage />}

          {/* Jungle page */}
          {renderPage === 'jungle' && <JunglePage />}

          {/* PNTHR AI Jungle — AI Universe (304 holdings, 16 sectors) */}
          {renderPage === 'aiJungle' && <AiJunglePage />}

          {/* PNTHR AI Sectors — 16 synthetic sector indices */}
          {renderPage === 'aiSectors' && <AiSectorsPage />}

          {/* PNTHR AI Orders — APEX v6 weekly order sheet (PIN protected) */}
          {renderPage === 'aiOrders' && <AumShield block showDuration><AiOrdersPage /></AumShield>}

          {/* PNTHR AMBUSH — V7.4 intraday Kanban dashboard (no regime gate, longs+shorts, 2-bar exit) */}
          {renderPage === 'ambush' && <AumShield block showDuration><AmbushPage /></AumShield>}

          {/* PNTHR AI Kill — v1 ranked predatory scoring */}
          {renderPage === 'aiKill' && <AiKillPage />}

          {/* PNTHR Heat — 679 Jungle sector heat map */}
          {renderPage === 'jungleHeat' && <JungleHeatPage />}

          {/* PNTHR AI Heat — AI 300 sector heat map */}
          {renderPage === 'aiHeat' && <AiHeatPage />}

          {/* PNTHR Bond Yields — treasury yields + shock detection */}
          {renderPage === 'bondHeat' && <BondHeatPage />}


          {/* PNTHR Journal */}
          {renderPage === 'journal' && <JournalPage onNavigate={navigate} initialFilter={journalInitFilter} focusPositionId={journalFocusId} focusTicker={journalFocusTicker} />}

          {/* Portfolio page */}
          {renderPage === 'portfolio' && <PortfolioPage currentUser={currentUser} onProfileUpdate={setCurrentUser} />}

          {/* PNTHR Kill History — admin only */}
          {renderPage === 'history' && (isAdmin
            ? <HistoryPage />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted to admins.</div>
          )}

          {/* PNTHR Kill Test — admin only */}
          {renderPage === 'kill-test' && (isAdmin
            ? <KillTestPage />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted to admins.</div>
          )}

          {/* Intelligence Report Live — Carnivore variant */}
          {renderPage === 'ir-live' && (isAdmin || effectiveAllowed?.includes('ir-live')
            ? <IrLivePage fund="carnivore" />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted.</div>
          )}

          {/* Intelligence Report Live — AI Elite 300 variant */}
          {renderPage === 'ai-ir-live' && (isAdmin || effectiveAllowed?.includes('ir-live')
            ? <IrLivePage fund="ai300" />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted.</div>
          )}

          {/* Intelligence Report Live — Ambush V7.4 variant */}
          {renderPage === 'ambush-ir-live' && (isAdmin || effectiveAllowed?.includes('ir-live')
            ? <IrLivePage fund="ambush" />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted.</div>
          )}

          {/* TEST page — admin only */}
          {renderPage === 'test' && (isAdmin
            ? <TestPage />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted to admins.</div>
          )}

          {/* Signal History — admin only */}
          {renderPage === 'signal-history' && (isAdmin
            ? <SignalHistoryPage />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted to admins.</div>
          )}

          {/* AI 300 Signal History — admin only */}
          {renderPage === 'ai-signal-history' && (isAdmin
            ? <AiSignalHistoryPage />
            : <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Access restricted to admins.</div>
          )}

          {/* PNTHR Data Room */}
          {renderPage === 'data-room' && <DataRoomPage fund="carn" />}
          {renderPage === 'ai-data-room' && <DataRoomPage fund="ai" />}

          {/* PNTHR Compliance (admin only) */}
          {renderPage === 'compliance' && isAdmin && <CompliancePage />}

          {/* PNTHR Investor Management (admin only) */}
          {renderPage === 'investor-mgmt' && isAdmin && <InvestorManagementPage />}
        </main>

        <footer className="footer">
          <p>Data provided by Financial Modeling Prep • Live view cached for 5 minutes</p>
        </footer>
      </div>

      {/* Chart Modal (679 scanner) */}
      {chartIndex != null && (
        <AiTickerChartModal
          tickers={chartStocks.map(s => s.ticker || s)}
          initialIndex={chartIndex}
          onClose={() => setChartIndex(null)}
        />
      )}

      {/* AI Chart Modal (AI 300 scanner) */}
      {aiChartIndex != null && aiChartTickers.length > 0 && (
        <AiTickerChartModal
          tickers={aiChartTickers}
          initialIndex={aiChartIndex}
          onClose={() => { setAiChartIndex(null); setAiChartTickers([]); }}
        />
      )}

      {/* Floating queue counter — visible on all pages (hidden for investors) */}
      {isAuthenticated && !isInvestor && queueSize > 0 && !showQueuePanel && (
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

      {/* Send success toast (hidden for investors) */}
      {!isInvestor && sendSuccess && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 200,
          background: '#28a745', color: '#fff', fontWeight: 700, fontSize: 12,
          padding: '10px 18px', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
          ✓ Entries sent to PNTHR Assistant!
        </div>
      )}

      {/* Queue review panel (hidden for investors) */}
      {showQueuePanel && isAuthenticated && !isInvestor && (
        <QueueReviewPanel onClose={() => setShowQueuePanel(false)} />
      )}
    </div>
  );
}

export default App;
