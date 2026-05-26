import React, { useState, useEffect } from 'react';
import { fetchPulse, fetchLiveVix, fetchSignalStocks, fetchDevelopingSignals, fetchSectorExposure, fetchMovers, fetchPulseAi300, fetchAi300SignalStocks, fetchAi300Movers, fetchAi300DevelopingSignals, fetchSectorPerformanceCombined } from '../services/api';
import { useAnalyzeContext } from '../contexts/AnalyzeContext';
import { useAuth } from '../AuthContext';
import { computeAnalyzeScore } from '../utils/analyzeScore';
import AiTickerChartModal from './AiTickerChartModal';
import Pnthr300ChartModal from './Pnthr300ChartModal';
import AumShield from './AumShield';
import PageHeader from './PageHeader';
import { useFund } from '../contexts/FundContext';

// Returns true if developing signals should be shown (Mon–Thu anytime; Fri before 4:15 PM ET)
function shouldShowDevelopingSignals() {
  const now = new Date();
  // Convert to ET offset (EST = UTC-5, EDT = UTC-4)
  // Use Intl to get current ET hour/day
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false });
  // etStr like "Mon, 14:30"
  const etDay = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' }); // "Mon"
  const etHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const etMin  = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', minute: '2-digit', hour12: false }), 10);
  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const dow = dayMap[etDay] ?? 0;
  if (dow === 0 || dow === 6) return false;       // weekend
  if (dow >= 1 && dow <= 4) return true;           // Mon–Thu always show
  if (dow === 5) {                                 // Friday
    const totalMin = etHour * 60 + etMin;
    return totalMin < 16 * 60 + 15;               // before 4:15 PM ET
  }
  return false;
}

function formatScoresLabel(data) {
  if (!data) return 'Scores: Loading...';
  if (data.dataSource === 'live_apex') {
    // Live scoring — show today at the time scores were computed
    const d = data.scoresAsOf ? new Date(data.scoresAsOf) : new Date();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
    return `Scores: Live as of ${time} ET`;
  }
  if (data.dataSource === 'daily') {
    // Daily snapshot from 5 PM job
    const d = data.scoresAsOf ? new Date(data.scoresAsOf) : new Date();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
    return `Signals: Daily as of ${time} ET`;
  }
  // Friday pipeline — show the weekOf date clearly
  if (data.weekOf) {
    // weekOf is 'YYYY-MM-DD'; parse as local date to avoid UTC-off-by-one
    const [y, m, d] = data.weekOf.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return `Scores: ${label} (Fri pipeline)`;
  }
  return 'Scores: Fri pipeline';
}

function formatLoadedAt(date) {
  if (!date) return '';
  return 'Loaded: ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'America/New_York' }) + ' ET';
}

export default function PulsePage({ onNavigate, fund }) {
  const { analyzeContext } = useAnalyzeContext() || {};
  const { isInvestor } = useAuth() || {};
  const { activeFund: masterFund } = useFund();
  const activeFund = fund || masterFund;
  const [data, setData] = useState(null);
  const [vix, setVix] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [chartList, setChartList] = useState([]);
  const [chartIndex, setChartIndex] = useState(0);
  const [signalModal, setSignalModal] = useState(null);
  const [devSignals,      setDevSignals]      = useState(null);
  const [devLoading,      setDevLoading]      = useState(false);
  const [sectorExposure,  setSectorExposure]  = useState(null);
  const [movers,          setMovers]          = useState(null);
  const [sectorModal,     setSectorModal]     = useState(null); // { sector, data }
  const [showPai300Chart, setShowPai300Chart] = useState(false);
  // ── Tab state: synced from global fund toggle ──
  const [pulseTab, setPulseTab] = useState(activeFund === 'ai' ? 'ai300' : '679');
  // ── AI 300 data ──
  const [ai300Data,       setAi300Data]       = useState(null);
  const [ai300Loading,    setAi300Loading]    = useState(false);
  const [ai300Movers,     setAi300Movers]     = useState(null);
  const [ai300DevSignals, setAi300DevSignals] = useState(null);
  const [ai300DevLoading, setAi300DevLoading] = useState(false);
  const [ai300ChartList,  setAi300ChartList]  = useState([]);
  const [ai300ChartIndex, setAi300ChartIndex] = useState(0);
  const [ai300SignalModal, setAi300SignalModal] = useState(null);
  const [ai300SectorModal, setAi300SectorModal] = useState(null); // sector name string
  const [ai300NewSigModal, setAi300NewSigModal] = useState(null); // { signal: 'BL'|'SS', sector: string|null }
  const [sectorPerf, setSectorPerf] = useState(null);
  const autoRefreshTimer = React.useRef(null);
  const pollingTimer = React.useRef(null);
  const sectorPerfTimer = React.useRef(null);
  const showDev = shouldShowDevelopingSignals();

  // Sync in-page tab when master fund toggle changes
  useEffect(() => {
    const tab = activeFund === 'ai' ? 'ai300' : '679';
    switchTab(tab);
  }, [activeFund]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDevSignals() {
    if (!shouldShowDevelopingSignals()) return;
    setDevLoading(true);
    try {
      const result = await fetchDevelopingSignals();
      setDevSignals(result);
    } catch (err) {
      console.warn('Developing signals fetch failed:', err);
    } finally {
      setDevLoading(false);
    }
  }

  function switchTab(tab) {
    setPulseTab(tab);
    sessionStorage.setItem('pulseTab', tab);
    if (tab === 'ai300' && !ai300Data && !ai300Loading) loadAi300();
  }

  async function loadAi300() {
    setAi300Loading(true);
    try {
      const result = await fetchPulseAi300();
      setAi300Data(result);
    } catch (err) {
      console.error('AI 300 Pulse fetch failed:', err);
    } finally {
      setAi300Loading(false);
    }
    fetchAi300Movers().then(setAi300Movers).catch(err => console.warn('AI 300 Movers failed:', err));
    if (shouldShowDevelopingSignals()) {
      setAi300DevLoading(true);
      fetchAi300DevelopingSignals().then(setAi300DevSignals).catch(err => console.warn('AI 300 dev signals failed:', err)).finally(() => setAi300DevLoading(false));
    }
  }

  async function refreshPulse() {
    if (isRefreshing) return;
    if (autoRefreshTimer.current) { clearTimeout(autoRefreshTimer.current); autoRefreshTimer.current = null; }
    setIsRefreshing(true);
    try {
      const [pulse, vixData] = await Promise.all([fetchPulse(), fetchLiveVix()]);
      setData(pulse);
      setVix(vixData);
      setLastRefresh(new Date());
      // If still warming, schedule another check in 90s
      if (pulse.cacheWarming) {
        autoRefreshTimer.current = setTimeout(refreshPulse, 90_000);
      }
    } catch (err) {
      console.error('Refresh failed:', err);
    } finally {
      setIsRefreshing(false);
    }
    // Re-fetch developing signals on manual refresh
    loadDevSignals();
    fetchMovers().then(setMovers).catch(err => console.warn('Movers refresh failed:', err));
    fetchSectorPerformanceCombined().then(setSectorPerf).catch(() => {});
    // Also refresh AI 300 if that tab has been loaded
    if (ai300Data) loadAi300();
  }

  useEffect(() => {
    Promise.all([fetchPulse(), fetchLiveVix(), isInvestor ? Promise.resolve(null) : fetchSectorExposure().catch(() => null)])
      .then(([pulse, vixData, secExp]) => {
        setData(pulse);
        setVix(vixData);
        if (secExp) setSectorExposure(secExp);
        setLastRefresh(new Date());
        if (pulse.cacheWarming) {
          autoRefreshTimer.current = setTimeout(refreshPulse, 90_000);
        }
      })
      .catch(err => { console.error(err); setError(err.message); })
      .finally(() => setLoading(false));
    loadDevSignals();
    fetchMovers().then(setMovers).catch(err => console.warn('Movers load failed:', err));
    fetchSectorPerformanceCombined().then(setSectorPerf).catch(err => console.warn('Sector perf load failed:', err));
    if (sessionStorage.getItem('pulseTab') === 'ai300') loadAi300();

    // 5-minute auto-refresh during extended market hours (7 AM – 8 PM ET, Mon–Fri)
    function isMarketWindow() {
      const now = new Date();
      const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const day = et.getDay();
      if (day === 0 || day === 6) return false;
      const h = et.getHours();
      return h >= 7 && h < 20;
    }
    pollingTimer.current = setInterval(() => {
      if (isMarketWindow()) refreshPulse();
    }, 5 * 60 * 1000);
    // Hourly refresh for sector performance chart
    sectorPerfTimer.current = setInterval(() => {
      if (isMarketWindow()) fetchSectorPerformanceCombined().then(setSectorPerf).catch(() => {});
    }, 60 * 60 * 1000);

    return () => {
      if (autoRefreshTimer.current) clearTimeout(autoRefreshTimer.current);
      if (pollingTimer.current) clearInterval(pollingTimer.current);
      if (sectorPerfTimer.current) clearInterval(sectorPerfTimer.current);
    };
  }, []);

  if (loading) return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#D4A017', fontSize: 18, fontFamily: 'monospace' }}>
      Loading Pulse...
    </div>
  );
  if (!data) return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', color: '#ff6b6b', padding: 40, fontFamily: 'monospace' }}>
      <div>Failed to load Pulse data.</div>
      {error && <div style={{ marginTop: 12, fontSize: 13, color: '#ff9999', background: '#1a0000', padding: '10px 14px', borderRadius: 6, maxWidth: 600 }}>{error}</div>}
    </div>
  );

  return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh', padding: '16px 24px', fontFamily: 'monospace' }}>
      <PageHeader title="PNTHR Pulse" description="Real-time equity curves, market regime gauges, and sector performance for both funds." />
      {/* STATUS LIGHT */}
      <StatusLight
        status={data.statusLight}
        message={data.statusMessage}
        positions={isInvestor ? null : data.positions}
        pulseData={data}
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={refreshPulse}
      />

      {/* ── MARKET OVERVIEW: 3 rows of gauges ── */}
      <div style={{ border: '1px solid rgba(255,215,0,0.35)', borderRadius: 10, background: '#0d0d0d', padding: '14px 16px 10px', marginBottom: 14 }}>
        <div style={{ color: '#FFD700', fontSize: 10, fontWeight: 700, letterSpacing: 2.5, marginBottom: 10, textTransform: 'uppercase', opacity: 0.6 }}>MARKET OVERVIEW</div>
        {/* ROW 1: PAI300 + Equity markets */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Pai300Gauge pai300={data.pai300} onClick={() => setShowPai300Chart(true)} />
          <SpyGauge regime={data.regime} rsi={data.indexRsi?.spy} onClick={() => { setChartList([{ ticker: 'SPY' }]); setChartIndex(0); }} />
          <QqqGauge regime={data.regime} rsi={data.indexRsi?.qqq} onClick={() => { setChartList([{ ticker: 'QQQ' }]); setChartIndex(0); }} />
          <MarketGauge label="NYSE" subLabel="Composite" data={data.marketGauges?.nyse} rsi={data.indexRsi?.nyse} onClick={() => { setChartList([{ ticker: '^NYA' }]); setChartIndex(0); }} />
          <MarketGauge label="NASDAQ" subLabel="Composite" data={data.marketGauges?.nasdaq} rsi={data.indexRsi?.nasdaq} onClick={() => { setChartList([{ ticker: '^IXIC' }]); setChartIndex(0); }} />
          <MarketGauge label="IWM" subLabel="Russell 2000" data={data.marketGauges?.iwm} rsi={data.indexRsi?.iwm} onClick={() => { setChartList([{ ticker: 'IWM' }]); setChartIndex(0); }} />
          <MarketGauge label="DJI" subLabel="Dow Jones" data={data.marketGauges?.dji} rsi={data.indexRsi?.dji} onClick={() => { setChartList([{ ticker: '^DJI' }]); setChartIndex(0); }} />
        </div>
        {/* ROW 2: VIX + Commodities & Currency */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <VixThermometer vix={vix} onClick={() => { setChartList([{ ticker: '^VIX' }]); setChartIndex(0); }} />
          <MarketGauge label="GLD" subLabel="Gold" data={data.marketGauges?.gld} isGold={true} onClick={() => { setChartList([{ ticker: 'GLD' }]); setChartIndex(0); }} />
          <MarketGauge label={data.marketGauges?.crude?.symbol === 'USO' ? 'USO' : 'WTI'} subLabel="Crude Oil" data={data.marketGauges?.crude} onClick={() => { setChartList([{ ticker: data.marketGauges?.crude?.symbol || 'USO' }]); setChartIndex(0); }} />
          <MarketGauge label="USD" subLabel="Dollar Index" data={data.marketGauges?.usd} isIndex={true} onClick={() => { setChartList([{ ticker: 'UUP' }]); setChartIndex(0); }} />
          <MarketGauge label="BTC" subLabel="Bitcoin" data={data.marketGauges?.btc} isBtc={true} onClick={() => { setChartList([{ ticker: 'BTCUSD' }]); setChartIndex(0); }} />
        </div>
        {/* ROW 3: Interest rates + macro */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <YieldGauge label="FED" subLabel="Fed Rate (1mo)" data={data.treasuryYields?.fed} />
          <YieldGauge label="2Y" subLabel="2-Year Yield" data={data.treasuryYields?.y2} />
          <YieldGauge label="10Y" subLabel="10-Year Yield" data={data.treasuryYields?.y10} />
          <YieldGauge label="30Y" subLabel="30-Year Yield" data={data.treasuryYields?.y30} />
          <RecessionGauge data={data.recessionIndicator} />
          <BuffettGauge data={data.buffettIndicator} />
          <ConsumerSentimentGauge data={data.consumerSentiment} />
        </div>
      </div>

      {/* ── TAB BAR: Carnivore | PNTHR AI 300 ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {[
          { key: '679',   label: 'Carnivore',    count: data?.signals?.blCount != null ? `${data.signals.blCount + data.signals.ssCount} signals` : null },
          { key: 'ai300', label: 'PNTHR AI 300', count: ai300Data?.signals?.blCount != null ? `${ai300Data.signals.blCount + ai300Data.signals.ssCount} signals` : null },
        ].map(tab => {
          const active = pulseTab === tab.key;
          return (
            <button key={tab.key} onClick={() => switchTab(tab.key)} style={{
              padding: '8px 20px', borderRadius: 6, border: active ? '1px solid #FFD700' : '1px solid #333',
              background: active ? 'rgba(255,215,0,0.12)' : '#111', color: active ? '#FFD700' : '#666',
              fontWeight: active ? 800 : 600, fontSize: 13, fontFamily: 'monospace', letterSpacing: 1.5,
              cursor: 'pointer', transition: 'all 0.15s',
            }}>
              {tab.label}
              {tab.count && <span style={{ marginLeft: 8, fontSize: 10, color: active ? '#D4A017' : '#444', fontWeight: 400 }}>({tab.count})</span>}
            </button>
          );
        })}
      </div>

      {/* ══════════════════════ Carnivore TAB ══════════════════════ */}
      {pulseTab === '679' && <>
        {/* Regime */}
        <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '12px 14px', marginBottom: 14 }}>
          <RegimeStrip regime={data.regime} signals={data.signals} positions={isInvestor ? null : data.positions} />
        </div>
        {/* Kill Top 10 + Sector Pulse */}
        <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <KillTop10 killTop10={data.killTop10} onTickerClick={(stocks, idx) => { setChartList(stocks); setChartIndex(idx); }} killDataLive={data.killDataLive} analyzeContext={analyzeContext} />
            <SectorPulse signals={data.signals} killDataLive={data.killDataLive} onNavigate={onNavigate} newSignals={data.newSignals} />
          </div>
        </div>
        {/* New Signals */}
        <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
          <NewSignalsPanel newSignals={data.newSignals} onTickerClick={(stocks, idx) => { setChartList(stocks); setChartIndex(idx); }} analyzeContext={analyzeContext} />
        </div>
        {/* Developing Signals */}
        {showDev && (
          <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
            <DevelopingSignalsPanel devSignals={devSignals} loading={devLoading} onTickerClick={(stocks, idx) => { setChartList(stocks); setChartIndex(idx); }} analyzeContext={analyzeContext} />
          </div>
        )}
        {/* Signal Breadth */}
        <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
          <SignalBreadthBar signals={data.signals} onSignalClick={setSignalModal} />
        </div>
        {/* Movers */}
        <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
          <MoversPanel movers={movers} onTickerClick={(stocks, idx) => { setChartList(stocks); setChartIndex(idx); }} />
        </div>
        {/* Sector Performance — 27 sectors ranked by 5D return */}
        <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
          <SectorPerformanceChart data={sectorPerf} />
        </div>
      </>}

      {/* ══════════════════════ PNTHR AI 300 TAB ══════════════════════ */}
      {pulseTab === 'ai300' && (
        ai300Loading && !ai300Data ? (
          <div style={{ background: '#111', borderRadius: 12, padding: '40px 20px', textAlign: 'center', color: '#D4A017', fontSize: 14, fontFamily: 'monospace' }}>
            Loading AI 300 Pulse...
          </div>
        ) : ai300Data ? <>
          {/* Regime */}
          <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '12px 14px', marginBottom: 14 }}>
            <Ai300RegimeStrip regime={ai300Data.regime} signals={ai300Data.signals} positions={isInvestor ? null : ai300Data.positions} pai300={ai300Data.pai300} />
          </div>
          {/* Kill Top 10 + Sector Pulse */}
          <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <KillTop10 killTop10={ai300Data.killTop10} onTickerClick={(stocks, idx) => { setAi300ChartList(stocks); setAi300ChartIndex(idx); }} killDataLive={ai300Data.killDataLive} analyzeContext={analyzeContext} universeLabel="AI 300" />
              <Ai300SectorPulse signals={ai300Data.signals} sectorTiers={ai300Data.sectorTiers} killDataLive={ai300Data.killDataLive} newSignals={ai300Data.newSignals} onNavigate={onNavigate} allSignalStocks={ai300Data.allSignalStocks} onSectorStockClick={(sectorName) => setAi300SectorModal(sectorName)} onNewSignalClick={(sig, sector) => setAi300NewSigModal({ signal: sig, sector })} />
            </div>
          </div>
          {/* New Signals */}
          <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
            <NewSignalsPanel newSignals={ai300Data.newSignals} onTickerClick={(stocks, idx) => { setAi300ChartList(stocks); setAi300ChartIndex(idx); }} analyzeContext={analyzeContext} universeLabel="AI 300" />
          </div>
          {/* Developing Signals */}
          {showDev && (
            <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
              <DevelopingSignalsPanel devSignals={ai300DevSignals} loading={ai300DevLoading} onTickerClick={(stocks, idx) => { setAi300ChartList(stocks); setAi300ChartIndex(idx); }} analyzeContext={analyzeContext} />
            </div>
          )}
          {/* Signal Breadth */}
          <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
            <SignalBreadthBar signals={ai300Data.signals} onSignalClick={setAi300SignalModal} />
          </div>
          {/* Movers */}
          <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
            <Ai300MoversPanel movers={ai300Movers} onTickerClick={(stocks, idx) => { setAi300ChartList(stocks); setAi300ChartIndex(idx); }} />
          </div>
          {/* Sector Performance — 27 sectors ranked by 5D return */}
          <div style={{ border: '1px solid rgba(255,215,0,0.30)', borderRadius: 10, background: '#0c0c0c', padding: '14px 14px', marginBottom: 14 }}>
            <SectorPerformanceChart data={sectorPerf} />
          </div>
        </> : (
          <div style={{ background: '#111', borderRadius: 12, padding: '40px 20px', textAlign: 'center', color: '#ff6b6b', fontSize: 14, fontFamily: 'monospace' }}>
            Failed to load AI 300 data. Click REFRESH to retry.
          </div>
        )
      )}

      {/* ── Shared modals ── */}
      {sectorModal && (
        <SectorTickersModal
          sector={sectorModal.sector}
          data={sectorModal.data}
          opposites={sectorExposure?.oppositesBySector?.[sectorModal.sector] || null}
          onClose={() => setSectorModal(null)}
          onTickerClick={(ticker, allTickers) => {
            setSectorModal(null);
            const stocks = allTickers.map(t => ({ ticker: t }));
            const idx = Math.max(0, stocks.findIndex(s => s.ticker === ticker));
            setChartList(stocks);
            setChartIndex(idx);
          }}
        />
      )}
      {signalModal && (
        <SignalStockModal signal={signalModal} onClose={() => setSignalModal(null)} onTickerClick={(stocks, idx) => { setSignalModal(null); setChartList(stocks); setChartIndex(idx); }} />
      )}
      {ai300NewSigModal && ai300Data && (
        <Ai300NewSignalModal
          signal={ai300NewSigModal.signal}
          sector={ai300NewSigModal.sector}
          newSignals={ai300Data.newSignals}
          onClose={() => setAi300NewSigModal(null)}
          onTickerClick={(tickers, idx) => { setAi300NewSigModal(null); setAi300ChartList(tickers); setAi300ChartIndex(idx); }}
        />
      )}
      {ai300SectorModal && ai300Data && (
        <Ai300SectorStocksModal
          sectorName={ai300SectorModal}
          allSignalStocks={ai300Data.allSignalStocks || []}
          sectorTier={ai300Data.sectorTiers?.[ai300SectorModal] || null}
          onClose={() => setAi300SectorModal(null)}
          onTickerClick={(tickers, idx) => { setAi300SectorModal(null); setAi300ChartList(tickers); setAi300ChartIndex(idx); }}
        />
      )}
      {ai300SignalModal && (
        <Ai300SignalStockModal signal={ai300SignalModal} onClose={() => setAi300SignalModal(null)} onTickerClick={(stocks, idx) => { setAi300SignalModal(null); setAi300ChartList(stocks); setAi300ChartIndex(idx); }} />
      )}
      {chartList.length > 0 && (
        <AiTickerChartModal tickers={chartList.map(s => s.ticker || s)} initialIndex={chartIndex} onClose={() => { setChartList([]); setChartIndex(0); }} />
      )}
      {ai300ChartList.length > 0 && (
        <AiTickerChartModal tickers={ai300ChartList.map(s => s.ticker || s)} initialIndex={ai300ChartIndex} onClose={() => { setAi300ChartList([]); setAi300ChartIndex(0); }} />
      )}
      {showPai300Chart && (
        <Pnthr300ChartModal onClose={() => setShowPai300Chart(false)} />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusLight({ status, message, positions, pulseData, lastRefresh, isRefreshing, onRefresh }) {
  const color = status === 'RED' ? '#dc3545' : status === 'YELLOW' ? '#ffc107' : '#28a745';
  const pulse = status !== 'GREEN';
  const [hovRefresh, setHovRefresh] = useState(false);

  const isLive = pulseData?.dataSource === 'live_apex';
  const isDaily = pulseData?.dataSource === 'daily';
  const dataBadge = isRefreshing
    ? { dot: '#ffc107', label: 'Refreshing...', anim: true }
    : isLive
      ? { dot: '#28a745', label: 'Live',         anim: false }
      : isDaily
        ? { dot: '#28a745', label: 'Daily',       anim: false }
        : { dot: '#ffc107', label: 'Fri Pipeline', anim: false };

  const isWarming = pulseData?.cacheWarming && !isRefreshing;
  const scoresLabel = isRefreshing ? 'Scores: Refreshing...'
    : isWarming ? 'Scores: Computing live scores... (auto-refreshes in ~90s)'
    : formatScoresLabel(pulseData);
  const loadedLabel = formatLoadedAt(lastRefresh);

  return (
    <div style={{
      marginBottom: 16, borderRadius: 8,
      border: `1px solid ${color}22`,
      background: `${color}11`,
      animation: pulse ? 'statusPulse 2s ease-in-out infinite' : 'none',
      overflow: 'hidden',
    }}>
      <style>{`
        @keyframes statusPulse { 0%,100% { opacity:0.85 } 50% { opacity:1 } }
        @keyframes spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
      `}</style>

      {/* Row 1: status dot · message · positions · heat · REFRESH */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '9px 18px', gap: 10 }}>
        <div style={{ width: 11, height: 11, borderRadius: '50%', background: color, boxShadow: `0 0 7px ${color}`, flexShrink: 0 }} />
        <span style={{ color, fontWeight: 700, fontSize: 13, letterSpacing: 2, flex: 1 }}>{message}</span>
        {positions && (
          <span style={{ color: '#777', fontSize: 12 }}>
            {positions.total} positions · {Math.round((positions.heat?.totalRiskPct || 0) * 10) / 10}% heat
          </span>
        )}
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          onMouseEnter={() => setHovRefresh(true)}
          onMouseLeave={() => setHovRefresh(false)}
          style={{
            background: hovRefresh ? 'rgba(255,215,0,0.1)' : 'transparent',
            border: '1px solid #FFD700',
            color: '#FFD700',
            padding: '3px 10px',
            borderRadius: 4,
            cursor: isRefreshing ? 'wait' : 'pointer',
            fontSize: 11,
            fontFamily: 'monospace',
            fontWeight: 700,
            letterSpacing: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            boxShadow: hovRefresh ? '0 0 8px rgba(255,215,0,0.2)' : 'none',
            transition: 'all 0.15s',
          }}
        >
          <span style={{ display: 'inline-block', animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
          {isRefreshing ? 'REFRESHING...' : 'REFRESH'}
        </button>
      </div>

      {/* Row 2: scores vintage · prices · loaded-at · data badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px 7px', borderTop: `1px solid ${color}11` }}>
        <span style={{ color: (isLive || isDaily) ? '#6bcb77' : '#888', fontSize: 11, fontFamily: 'monospace' }}>
          {scoresLabel}
          <span style={{ color: '#444', marginLeft: 12 }}>· Prices: Live</span>
          {loadedLabel && <span style={{ color: '#333', marginLeft: 12 }}>· {loadedLabel}</span>}
          <span style={{ color: '#555', marginLeft: 12 }}>· Auto-refresh: 5m</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: dataBadge.dot,
            boxShadow: `0 0 5px ${dataBadge.dot}`,
            animation: dataBadge.anim ? 'statusPulse 1s ease-in-out infinite' : 'none',
            flexShrink: 0,
          }} />
          <span style={{ color: dataBadge.dot, fontFamily: 'monospace' }}>Data: {dataBadge.label}</span>
        </span>
      </div>
    </div>
  );
}

function RsiBadge({ rsi }) {
  if (rsi == null) return null;
  return (
    <div
      title="Daily RSI(14)"
      style={{
        background: '#FCF000', color: '#000',
        fontSize: 10, fontWeight: 800, letterSpacing: 0.3,
        padding: '2px 6px', borderRadius: 3,
        fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1, marginTop: 2,
      }}
    >
      RSI {rsi}
    </div>
  );
}

function SemiGauge({ value, min, max, zones, label, displayValue, subLabel, subValue, subValueColor, gaugeW, gaugeH, onClick, rsi }) {
  const W = gaugeW ?? 180, H = gaugeH ?? 110;
  const cx = W / 2, cy = H - 10, r = Math.round(W * 80 / 180);

  const toAngle = (v) => {
    const pct = Math.max(0, Math.min(1, (v - min) / (max - min)));
    return Math.PI + pct * Math.PI;
  };

  const arcPath = (a1, a2) => {
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const large = Math.abs(a2 - a1) > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const clampedValue = Math.max(min, Math.min(max, value ?? 0));
  const needleAngle = toAngle(clampedValue);
  const nx = cx + r * 0.8 * Math.cos(needleAngle);
  const ny = cy + r * 0.8 * Math.sin(needleAngle);

  return (
    <div onClick={onClick} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#111', borderRadius: 12, padding: '12px 16px', minWidth: 160, cursor: onClick ? 'pointer' : 'default', transition: 'filter 0.15s ease' }} onMouseEnter={e => { if (onClick) e.currentTarget.style.filter = 'brightness(1.15)'; }} onMouseLeave={e => { if (onClick) e.currentTarget.style.filter = 'none'; }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <path d={arcPath(Math.PI, 2 * Math.PI)} fill="none" stroke="#222" strokeWidth={14} />
        {zones.map((z, i) => {
          const a1 = toAngle(z.from), a2 = toAngle(z.to);
          return <path key={i} d={arcPath(a1, a2)} fill="none" stroke={z.color} strokeWidth={12} opacity={0.7} />;
        })}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#FFD700" strokeWidth={3} strokeLinecap="round" />
        {/* PNTHR head pivot */}
        <circle cx={cx} cy={cy} r={13} fill="#0a0a0a" stroke="#FFD700" strokeWidth={1.5} />
        <image href="/favicon.png" x={cx - 10} y={cy - 10} width={20} height={20} />
      </svg>
      <div style={{ color: '#FFD700', fontSize: 11, fontWeight: 700, letterSpacing: 2, marginTop: 4 }}>{label}</div>
      <div style={{ color: '#fff', fontSize: 20, fontWeight: 800 }}>{displayValue ?? '—'}</div>
      <div style={{ color: '#888', fontSize: 10 }}>{subLabel}</div>
      {subValue && <div style={{ color: subValueColor || '#fff', fontSize: 13, fontWeight: 600, textAlign: 'center' }}>{subValue}</div>}
      <RsiBadge rsi={rsi} />
    </div>
  );
}

function SpyGauge({ regime, rsi, onClick }) {
  const spy = regime?.spy;
  const sep = (spy?.close && spy?.ema21 > 0) ? +((spy.close - spy.ema21) / spy.ema21 * 100).toFixed(1) : null;
  // Compute separation from stored regime fields (indexPosition/spyAboveEma)
  const pos = regime?.indexPosition;
  const zones = [
    { from: -20, to: -10, color: '#dc3545' },
    { from: -10, to: -3,  color: '#ff6b6b' },
    { from: -3,  to:  3,  color: '#555' },
    { from:  3,  to:  10, color: '#6bcb77' },
    { from:  10, to:  20, color: '#28a745' },
  ];
  // If no spy price data, show bull/bear indicator based on indexPosition
  const needleVal = sep !== null ? sep : (pos === 'above' ? 5 : pos === 'below' ? -5 : 0);
  return (
    <SemiGauge
      value={needleVal} min={-20} max={20} zones={zones}
      label="SPY"
      gaugeW={150} gaugeH={100}
      displayValue={spy?.close ? `$${spy.close.toFixed(2)}` : (pos ? (pos === 'above' ? '▲ ABOVE' : '▼ BELOW') : '—')}
      subLabel={spy?.ema21 > 0 ? `vs $${spy.ema21.toFixed(2)} EMA` : (spy?.close ? 'EMA pending' : regime?.weekOf ? `Week ${regime.weekOf}` : 'No data')}
      subValue={sep !== null ? `${sep > 0 ? '+' : ''}${sep}%` : (pos ? `${pos} EMA` : null)}
      subValueColor={sep !== null ? (sep >= 0 ? '#28a745' : '#dc3545') : (pos === 'above' ? '#28a745' : '#dc3545')}
      onClick={onClick}
      rsi={rsi}
    />
  );
}

function QqqGauge({ regime, rsi, onClick }) {
  const qqq = regime?.qqq;
  const sep = (qqq?.close && qqq?.ema21 > 0) ? +((qqq.close - qqq.ema21) / qqq.ema21 * 100).toFixed(1) : null;
  const pos = regime?.qqqAboveEma != null ? (regime.qqqAboveEma ? 'above' : 'below') : null;
  const zones = [
    { from: -20, to: -10, color: '#dc3545' },
    { from: -10, to: -3,  color: '#ff6b6b' },
    { from: -3,  to:  3,  color: '#555' },
    { from:  3,  to:  10, color: '#6bcb77' },
    { from:  10, to:  20, color: '#28a745' },
  ];
  const needleVal = sep !== null ? sep : (pos === 'above' ? 5 : pos === 'below' ? -5 : 0);
  return (
    <SemiGauge
      value={needleVal} min={-20} max={20} zones={zones}
      label="QQQ"
      gaugeW={150} gaugeH={100}
      displayValue={qqq?.close ? `$${qqq.close.toFixed(2)}` : (pos ? (pos === 'above' ? '▲ ABOVE' : '▼ BELOW') : '—')}
      subLabel={qqq?.ema21 > 0 ? `vs $${qqq.ema21.toFixed(2)} EMA` : (qqq?.close ? 'EMA pending' : regime?.weekOf ? `Week ${regime.weekOf}` : 'No data')}
      subValue={sep !== null ? `${sep > 0 ? '+' : ''}${sep}%` : (pos ? `${pos} EMA` : null)}
      subValueColor={sep !== null ? (sep >= 0 ? '#28a745' : '#dc3545') : (pos === 'above' ? '#28a745' : '#dc3545')}
      onClick={onClick}
      rsi={rsi}
    />
  );
}

function Pai300Gauge({ pai300, onClick }) {
  const value = pai300?.value ?? null;
  const ema   = pai300?.ema21W ?? null;
  const sep   = (value && ema > 0) ? +((value - ema) / ema * 100).toFixed(1) : null;
  const regime = pai300?.regime ?? null;
  const needleVal = sep !== null ? sep : (regime === 'bull' ? 5 : regime === 'bear' ? -5 : 0);
  const zones = [
    { from: -20, to: -10, color: '#dc3545' },
    { from: -10, to: -3,  color: '#ff6b6b' },
    { from: -3,  to:  3,  color: '#555' },
    { from:  3,  to:  10, color: '#6bcb77' },
    { from:  10, to:  20, color: '#28a745' },
  ];

  return (
    <SemiGauge
      value={needleVal} min={-20} max={20} zones={zones}
      label="PAI 300"
      gaugeW={150} gaugeH={100}
      displayValue={value ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}
      subLabel={ema > 0 ? `vs ${ema.toFixed(2)} EMA` : 'PNTHR AI 300'}
      subValue={sep !== null ? `${sep > 0 ? '+' : ''}${sep}%` : (regime ? `${regime === 'bull' ? 'above' : 'below'} EMA` : null)}
      subValueColor={sep !== null ? (sep >= 0 ? '#28a745' : '#dc3545') : (regime === 'bull' ? '#28a745' : '#dc3545')}
      onClick={onClick}
      rsi={pai300?.rsi ?? null}
    />
  );
}

function RegimeIndicator({ regime, signals }) {
  const pos = regime?.indexPosition || 'unknown';
  const isBear = pos === 'below';
  const isBull = pos === 'above';
  const bg = isBear ? 'rgba(220,53,69,0.15)' : isBull ? 'rgba(40,167,69,0.15)' : 'rgba(100,100,100,0.15)';
  const border = isBear ? '#dc3545' : isBull ? '#28a745' : '#555';
  const label = isBear ? 'BEARISH' : isBull ? 'BULLISH' : 'NEUTRAL';
  const labelColor = isBear ? '#ff6b6b' : isBull ? '#6bcb77' : '#888';

  const ssD1 = regime?.ssD1 ?? null;
  const blD1 = regime?.blD1 ?? null;

  return (
    <div style={{ flex: 1, minWidth: 200, background: bg, border: `2px solid ${border}33`, borderRadius: 12, padding: '16px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, fontWeight: 700 }}>⚡ REGIME</div>
      <div style={{ color: labelColor, fontSize: 28, fontWeight: 900, letterSpacing: 4 }}>{label}</div>
      {ssD1 !== null && blD1 !== null ? (
        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
          <span style={{ color: '#ff6b6b', fontWeight: 700 }}>SS {ssD1.toFixed(2)}×</span>
          <span style={{ color: '#555' }}>|</span>
          <span style={{ color: '#6bcb77', fontWeight: 700 }}>BL {blD1.toFixed(2)}×</span>
        </div>
      ) : (
        <div style={{ color: '#FFD700', fontSize: 13, fontWeight: 700 }}>D1 computing...</div>
      )}
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888' }}>
        {regime?.weekOf && <span>Week {regime.weekOf}</span>}
        {signals && <span>SS:BL {(signals.ratio || 0).toFixed(1)}:1</span>}
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
        <span style={{ color: isBear ? '#ff6b6b' : '#6bcb77' }}>SPY {isBear ? '▼ below' : '▲ above'}</span>
        <span style={{ color: regime?.qqqAboveEma === false ? '#ff6b6b' : '#6bcb77' }}>QQQ {regime?.qqqAboveEma === false ? '▼ below' : '▲ above'}</span>
      </div>
    </div>
  );
}

// Equity zones (red left, green right)
const EQUITY_ZONES = [
  { from: -10, to: -5,  color: '#dc3545' },
  { from: -5,  to: -2,  color: '#ff6b6b' },
  { from: -2,  to:  2,  color: '#555' },
  { from:  2,  to:  5,  color: '#6bcb77' },
  { from:  5,  to:  10, color: '#28a745' },
];
// Gold zones (gray left, gold right)
const GOLD_ZONES = [
  { from: -10, to: -2,  color: '#444' },
  { from: -2,  to:  2,  color: '#666' },
  { from:  2,  to:  5,  color: '#C8A000' },
  { from:  5,  to:  10, color: '#FFD700' },
];
// Bitcoin zones (gray left, orange right)
const BTC_ZONES = [
  { from: -10, to: -5,  color: '#7a3000' },
  { from: -5,  to: -2,  color: '#a84400' },
  { from: -2,  to:  2,  color: '#555' },
  { from:  2,  to:  5,  color: '#c85a00' },
  { from:  5,  to:  10, color: '#F7931A' },
];

function MarketGauge({ label, subLabel, data, isGold, isIndex, isBtc, onClick, rsi }) {
  const price = data?.price ?? null;
  const changePct = data?.changePct ?? null;
  const needleVal = changePct !== null ? Math.max(-10, Math.min(10, changePct)) : 0;
  const zones = isGold ? GOLD_ZONES : isBtc ? BTC_ZONES : EQUITY_ZONES;

  function fmtPrice(p) {
    if (p == null) return '—';
    if (isIndex) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (p >= 1000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    return `$${p.toFixed(2)}`;
  }

  const pctColor = changePct === null ? '#888' : changePct >= 0 ? '#6bcb77' : '#ff6b6b';
  const arrow = changePct === null ? '' : changePct >= 0 ? '▲' : '▼';

  return (
    <SemiGauge
      value={needleVal} min={-10} max={10} zones={zones}
      label={label}
      gaugeW={150} gaugeH={100}
      displayValue={price !== null ? fmtPrice(price) : '—'}
      subLabel={subLabel}
      subValue={changePct !== null ? `${arrow} ${Math.abs(changePct).toFixed(2)}%` : 'No data'}
      subValueColor={pctColor}
      onClick={onClick}
      rsi={rsi}
    />
  );
}

// Yield zones: green=low/accommodative → red=high/restrictive
const YIELD_ZONES = [
  { from: 0, to: 2, color: '#28a745' },
  { from: 2, to: 4, color: '#ffc107' },
  { from: 4, to: 6, color: '#ff8c00' },
  { from: 6, to: 8, color: '#dc3545' },
];

function YieldGauge({ label, subLabel, data }) {
  const rate = data?.rate ?? null;
  const changeBps = data?.changeBps ?? null;
  const subValue = rate !== null
    ? (changeBps !== null ? `${changeBps >= 0 ? '+' : ''}${changeBps}bps` : '—')
    : 'No data';
  // Rising yields = tightening = bearish for stocks/bonds → red; falling = green
  const subValueColor = changeBps === null ? '#888' : changeBps > 0 ? '#ff6b6b' : changeBps < 0 ? '#6bcb77' : '#888';
  return (
    <SemiGauge
      value={rate ?? 0} min={0} max={8} zones={YIELD_ZONES}
      label={label}
      gaugeW={150} gaugeH={100}
      displayValue={rate !== null ? `${rate.toFixed(2)}%` : '—'}
      subLabel={subLabel}
      subValue={subValue}
      subValueColor={subValueColor}
    />
  );
}

const VCI_ZONES = [
  { from: 0, to: 0.3, color: '#6bcb77' },
  { from: 0.3, to: 0.7, color: '#4ecdc4' },
  { from: 0.7, to: 1.0, color: '#fcf000' },
  { from: 1.0, to: 1.5, color: '#ff6b6b' },
  { from: 1.5, to: 2.5, color: '#dc3545' },
];

const GAUGE_TOOLTIP_STYLE = {
  position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
  background: '#1a1a1a', border: '1px solid #fcf000', borderRadius: 8,
  padding: '10px 14px', width: 260, zIndex: 999, fontSize: 11, lineHeight: 1.5,
  color: '#ccc', textAlign: 'left', marginBottom: 6, pointerEvents: 'none',
};

function RecessionGauge({ data }) {
  const [hover, setHover] = React.useState(false);
  const gauge = !data ? (
    <SemiGauge
      value={0} min={0} max={2.5} zones={VCI_ZONES}
      label="RECESSION"
      gaugeW={150} gaugeH={100}
      displayValue="—"
      subLabel="PNTHR VCI"
      subValue="No data"
      subValueColor="#888"
    />
  ) : (
    <SemiGauge
      value={data.vci} min={0} max={2.5} zones={VCI_ZONES}
      label="RECESSION"
      gaugeW={150} gaugeH={100}
      displayValue={data.vci.toFixed(2)}
      subLabel="PNTHR VCI"
      subValue={data.triggered ? '⚠ TRIGGERED' : 'No Signal'}
      subValueColor={data.triggered ? '#ff6b6b' : '#6bcb77'}
    />
  );
  return (
    <div style={{ position: 'relative' }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {hover && (
        <div style={GAUGE_TOOLTIP_STYLE}>
          <div style={{ color: '#fcf000', fontWeight: 700, marginBottom: 4 }}>PNTHR Vicious Cycle Index</div>
          <div>Measures how fast the labor market is deteriorating by comparing the 3-month average adjusted unemployment rate to its 12-month low.</div>
          <div style={{ marginTop: 6 }}>When the gap reaches <span style={{ color: '#ff6b6b' }}>1.0 percentage point</span>, a recession has historically either started or is imminent.</div>
          {data && <div style={{ marginTop: 6, color: '#888' }}>As of: {data.asOf}</div>}
        </div>
      )}
      {gauge}
    </div>
  );
}

const BUFFETT_ZONES = [
  { from: 0, to: 73, color: '#6bcb77' },
  { from: 73, to: 95, color: '#4ecdc4' },
  { from: 95, to: 115, color: '#fcf000' },
  { from: 115, to: 140, color: '#ff6b6b' },
  { from: 140, to: 250, color: '#dc3545' },
];

function BuffettGauge({ data }) {
  const [hover, setHover] = React.useState(false);
  const shortZone = data ? (data.zone === 'SIGNIFICANTLY OVERVALUED' ? 'VERY OVERVALUED'
    : data.zone === 'SIGNIFICANTLY UNDERVALUED' ? 'VERY UNDERVALUED'
    : data.zone) : null;
  const color = data ? (data.ratio >= 140 ? '#dc3545' : data.ratio >= 115 ? '#ff6b6b' : data.ratio >= 95 ? '#fcf000' : '#6bcb77') : '#888';
  const gauge = !data ? (
    <SemiGauge
      value={0} min={0} max={250} zones={BUFFETT_ZONES}
      label="BUFFETT"
      gaugeW={150} gaugeH={100}
      displayValue="—"
      subLabel="Mkt Cap / GDP"
      subValue="No data"
      subValueColor="#888"
    />
  ) : (
    <SemiGauge
      value={data.ratio} min={0} max={250} zones={BUFFETT_ZONES}
      label="BUFFETT"
      gaugeW={150} gaugeH={100}
      displayValue={`${data.ratio}%`}
      subLabel="Mkt Cap / GDP"
      subValue={shortZone}
      subValueColor={color}
    />
  );
  return (
    <div style={{ position: 'relative' }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {hover && (
        <div style={GAUGE_TOOLTIP_STYLE}>
          <div style={{ color: '#fcf000', fontWeight: 700, marginBottom: 4 }}>Buffett Indicator</div>
          <div>Total US Stock Market Capitalization divided by GDP, expressed as a percentage.</div>
          <div style={{ marginTop: 6 }}><span style={{ color: '#6bcb77' }}>Below 73%</span> = Undervalued</div>
          <div><span style={{ color: '#fcf000' }}>95–115%</span> = Fair Value</div>
          <div><span style={{ color: '#ff6b6b' }}>115–140%</span> = Overvalued</div>
          <div><span style={{ color: '#dc3545' }}>Above 140%</span> = Very Overvalued</div>
          {data && <div style={{ marginTop: 6, color: '#888' }}>As of: {data.asOf} (quarterly)</div>}
        </div>
      )}
      {gauge}
    </div>
  );
}

const SENTIMENT_ZONES = [
  { from: 50, to: 65, color: '#dc3545' },
  { from: 65, to: 80, color: '#ff6b6b' },
  { from: 80, to: 95, color: '#fcf000' },
  { from: 95, to: 105, color: '#4ecdc4' },
  { from: 105, to: 111, color: '#6bcb77' },
];

function ConsumerSentimentGauge({ data }) {
  const [hover, setHover] = React.useState(false);
  const color = data ? (data.value >= 100 ? '#6bcb77' : data.value >= 80 ? '#4ecdc4' : data.value >= 65 ? '#fcf000' : data.value >= 50 ? '#ff6b6b' : '#dc3545') : '#888';
  const changeStr = data?.change != null ? `${data.change >= 0 ? '+' : ''}${data.change}` : null;
  const changeColor = data?.change != null ? (data.change > 0 ? '#6bcb77' : data.change < 0 ? '#ff6b6b' : '#888') : '#888';
  const gauge = !data ? (
    <SemiGauge
      value={80} min={50} max={111} zones={SENTIMENT_ZONES}
      label="SENTIMENT"
      gaugeW={150} gaugeH={100}
      displayValue="—"
      subLabel="Consumer Sentiment"
      subValue="No data"
      subValueColor="#888"
    />
  ) : (
    <SemiGauge
      value={data.value} min={50} max={111} zones={SENTIMENT_ZONES}
      label="SENTIMENT"
      gaugeW={150} gaugeH={100}
      displayValue={data.value.toFixed(1)}
      subLabel="Consumer Sentiment"
      subValue={data.zone}
      subValueColor={color}
    />
  );
  return (
    <div style={{ position: 'relative' }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {hover && (
        <div style={GAUGE_TOOLTIP_STYLE}>
          <div style={{ color: '#fcf000', fontWeight: 700, marginBottom: 4 }}>PNTHR Consumer Sentiment</div>
          <div>University of Michigan Consumer Sentiment Index. Measures consumer confidence in current and future economic conditions.</div>
          <div style={{ marginTop: 6 }}><span style={{ color: '#6bcb77' }}>100+</span> = Optimistic</div>
          <div><span style={{ color: '#4ecdc4' }}>80–100</span> = Healthy</div>
          <div><span style={{ color: '#fcf000' }}>65–80</span> = Cautious</div>
          <div><span style={{ color: '#ff6b6b' }}>50–65</span> = Pessimistic</div>
          <div><span style={{ color: '#dc3545' }}>Below 50</span> = Distressed</div>
          {changeStr && <div style={{ marginTop: 6, color: changeColor }}>Change: {changeStr} pts from prior reading</div>}
          {data && <div style={{ marginTop: 4, color: '#888' }}>As of: {data.asOf} (monthly)</div>}
        </div>
      )}
      {gauge}
    </div>
  );
}

function RegimeStrip({ regime, signals, positions }) {
  const pos = regime?.indexPosition || 'unknown';
  const isBear = pos === 'below';
  const isBull = pos === 'above';
  const label = isBear ? 'BEARISH' : isBull ? 'BULLISH' : 'NEUTRAL';
  const labelColor = isBear ? '#ff6b6b' : isBull ? '#6bcb77' : '#888';
  const borderColor = isBear ? '#dc3545' : isBull ? '#28a745' : '#555';
  const bg = isBear ? 'rgba(220,53,69,0.07)' : isBull ? 'rgba(40,167,69,0.07)' : 'rgba(100,100,100,0.07)';
  const ssD1 = regime?.ssD1 ?? null;
  const blD1 = regime?.blD1 ?? null;
  const ratio = signals?.ratio ?? null;
  const heat = positions?.heat;
  const nav = positions?.nav ?? 100000;
  const capacity = heat ? ((0.15 * nav) - heat.totalRisk).toFixed(0) : null;

  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      background: bg, border: `1px solid ${borderColor}33`, borderLeft: `3px solid ${borderColor}`,
      borderRadius: 4, padding: '9px 18px',
    }}>
      {/* Left: Regime */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ color: labelColor, fontWeight: 900, fontSize: 15, fontFamily: 'monospace', letterSpacing: 2 }}>
          ⚡ {label}
        </span>
        {ssD1 !== null && blD1 !== null ? (
          <span style={{ fontSize: 12 }}>
            <span style={{ color: '#ff6b6b', fontWeight: 700 }}>SS {ssD1.toFixed(2)}×</span>
            <span style={{ color: '#333', margin: '0 6px' }}>|</span>
            <span style={{ color: '#6bcb77', fontWeight: 700 }}>BL {blD1.toFixed(2)}×</span>
          </span>
        ) : null}
        <span style={{ color: '#555', fontSize: 11 }}>
          {ratio !== null ? `SS:BL ${ratio.toFixed(1)}:1` : ''}
          {regime?.weekOf ? ` · Week ${regime.weekOf}` : ''}
        </span>
        <span style={{ fontSize: 11 }}>
          <span style={{ color: isBear ? '#ff6b6b' : '#6bcb77' }}>SPY {isBear ? '▼' : '▲'}</span>
          <span style={{ color: '#333', margin: '0 5px' }}>·</span>
          <span style={{ color: regime?.qqqAboveEma === false ? '#ff6b6b' : '#6bcb77' }}>
            QQQ {regime?.qqqAboveEma === false ? '▼' : '▲'}
          </span>
        </span>
      </div>
      {/* Right: Portfolio Heat */}
      {heat && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <span style={{ color: '#555', fontSize: 11 }}>
            Stk {heat.stockRiskPct?.toFixed(1)}%/10% · ETF {heat.etfRiskPct?.toFixed(1)}%/5%
          </span>
          <span style={{ color: '#FFD700', fontWeight: 700, fontSize: 13, fontFamily: 'monospace' }}>
            Heat: {heat.totalRiskPct?.toFixed(1)}% / 15%
          </span>
          {capacity && (
            <span style={{ color: '#28a745', fontSize: 11 }}>
              ${Number(capacity).toLocaleString()} cap
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function VixThermometer({ vix, onClick }) {
  const val = vix?.close || 0;
  const change = vix?.change;
  const zones = [
    { from: 0,  to: 15, color: '#28a745' }, // CALM
    { from: 15, to: 25, color: '#ffc107' }, // NORMAL
    { from: 25, to: 35, color: '#ff8c00' }, // ELEVATED
    { from: 35, to: 50, color: '#dc3545' }, // FEAR
  ];
  const zoneLabel = val < 15 ? 'CALM' : val < 25 ? 'NORMAL' : val < 35 ? 'ELEVATED' : 'FEAR';
  const zoneColor = val < 15 ? '#28a745' : val < 25 ? '#ffc107' : val < 35 ? '#ff8c00' : '#dc3545';
  const changeStr = (change !== null && change !== undefined)
    ? `${change > 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}`
    : null;
  return (
    <SemiGauge
      value={val} min={0} max={50} zones={zones}
      label="VIX"
      gaugeW={150} gaugeH={100}
      displayValue={val ? val.toFixed(1) : '—'}
      subLabel="Fear Index"
      subValue={changeStr ? `${changeStr} · ${zoneLabel}` : zoneLabel}
      subValueColor={zoneColor}
      onClick={onClick}
    />
  );
}

function HeatGauge({ positions }) {
  const heat = positions?.heat || {};
  const total = heat.totalRiskPct || 0;
  const zones = [
    { from: 0,  to: 5,  color: '#28a745' },
    { from: 5,  to: 10, color: '#ffc107' },
    { from: 10, to: 13, color: '#ff8c00' },
    { from: 13, to: 15, color: '#dc3545' },
  ];
  const remaining = Math.max(0, 15 - total);
  const nav = positions?.nav || 100000;
  return (
    <SemiGauge
      value={total} min={0} max={15} zones={zones}
      label="PORTFOLIO HEAT"
      displayValue={`${total.toFixed(1)}%`}
      subLabel={`${(heat.stockRiskPct || 0).toFixed(1)}% stocks · ${(heat.etfRiskPct || 0).toFixed(1)}% ETFs`}
      subValue={<AumShield>{`$${Math.round(remaining / 100 * nav).toLocaleString()} capacity left`}</AumShield>}
      subValueColor="#28a745"
    />
  );
}

function KillTop10({ killTop10, onTickerClick, killDataLive, analyzeContext, universeLabel }) {
  // Build full chart-ready array once so every click gets the complete list
  const chartStocks = (killTop10 || []).map(x => ({
    ticker: x.ticker,
    symbol: x.ticker,
    currentPrice: x.currentPrice,
    signal: x.signal,
    sector: x.sector,
    stopPrice: x.stopPrice || null,
  }));

  return (
    <div style={{ flex: 1, minWidth: 280, background: '#111', borderRadius: 12, padding: '14px 16px', maxWidth: 380 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, letterSpacing: 2 }}>⚡ {universeLabel ? `${universeLabel} ` : 'PNTHR '}KILL TOP 10</span>
        {killDataLive === false && <span style={{ color: '#555', fontSize: 10, background: '#1a1a1a', padding: '1px 6px', borderRadius: 4 }}>Fri pipeline</span>}
        {killDataLive === true && <span style={{ color: '#28a745', fontSize: 10 }}>● live</span>}
      </div>
      {(!killTop10 || killTop10.length === 0) && <div style={{ color: '#555', fontSize: 12 }}>No kill scores yet.</div>}
      {killTop10 && killTop10.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px', borderBottom: '1px solid #333', marginBottom: 2, position: 'sticky', top: 0, background: '#111', zIndex: 2 }}>
          <span style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 18, fontFamily: 'monospace' }}>#</span>
          <span style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 50, fontFamily: 'monospace' }}>TICKER</span>
          <span style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 70, textAlign: 'right', fontFamily: 'monospace' }}>PRICE</span>
          <span style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 44, textAlign: 'right', fontFamily: 'monospace' }}>SCORE</span>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 100, textAlign: 'right', fontFamily: 'monospace' }}>
            <span style={{ color: '#FFD700' }}>L</span><span style={{ color: '#444' }}> · </span><span style={{ color: '#ccc' }}>C</span><span style={{ color: '#444' }}> · </span><span style={{ color: '#6bcb77' }}>H</span><span style={{ color: '#555', marginLeft: 4 }}>RSI</span>
          </span>
          <span style={{ minWidth: 32 }} />
        </div>
      )}
      {(killTop10 || []).map((s, i) => {
        const rc = s.rankChange;
        const ar = analyzeContext ? computeAnalyzeScore(s, analyzeContext) : null;
        const hasRsi = s.rsiCurrent != null;
        return (
          <div key={s.ticker} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px', borderBottom: '1px solid #1a1a1a', cursor: 'pointer', transition: 'background 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            onClick={() => onTickerClick(chartStocks, i)}
          >
            <span style={{ color: i === 0 ? '#FFD700' : '#555', fontSize: 11, minWidth: 18, fontFamily: 'monospace' }}>#{s.killRank || i + 1}</span>
            <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, minWidth: 50, textDecoration: 'underline', textDecorationColor: 'rgba(212,160,23,0.4)', fontFamily: 'monospace' }}>{s.ticker}</span>
            <span style={{ color: '#ccc', fontSize: 12, minWidth: 70, textAlign: 'right', fontFamily: 'monospace' }}>{s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}</span>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 12, minWidth: 44, textAlign: 'right', fontFamily: 'monospace' }}>{(s.totalScore || 0).toFixed(1)}</span>
            {hasRsi ? (
              <span style={{ fontSize: 10, fontFamily: 'monospace', minWidth: 100, textAlign: 'right', letterSpacing: 0.3 }} title={`RSI(14) — Low: ${s.rsiLow}  Current: ${s.rsiCurrent}  High: ${s.rsiHigh}`}>
                <span style={{ color: '#FFD700' }}>{s.rsiLow}</span>
                <span style={{ color: '#333' }}> · </span>
                <span style={{ color: '#fff', fontWeight: 700 }}>{s.rsiCurrent}</span>
                <span style={{ color: '#333' }}> · </span>
                <span style={{ color: '#6bcb77' }}>{s.rsiHigh}</span>
              </span>
            ) : (
              <span style={{ fontSize: 10, fontFamily: 'monospace', minWidth: 100, textAlign: 'right', color: '#333' }}>— · — · —</span>
            )}
            {ar && <span style={{ color: ar.color, fontSize: 11, fontWeight: 700, fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }} title={ar.warnings?.length ? ar.warnings[0] : `Pre-trade: ${ar.pct}%`}>{ar.pct}{ar.warnings?.length > 0 ? '⚠' : ''}</span>}
          </div>
        );
      })}
      <div style={{ marginTop: 10, color: '#555', fontSize: 11, cursor: 'pointer' }}>VIEW FULL KILL LIST →</div>
    </div>
  );
}

// ── PNTHR Sector Mini-Gauge ────────────────────────────────────────────────────
function PNTHRMiniGauge({ label, bl, ss, newBl = 0, newSs = 0, totalStocks = 0, highlight, onClick, onNewBlClick, onNewSsClick }) {
  const [hovered, setHovered] = useState(false);
  const total = bl + ss;
  const W = 160, H = 96;
  const cx = W / 2, cy = H - 10, r = 66;

  const toAngle = (v) => Math.PI + v * Math.PI;
  const arcPath = (a1, a2) => {
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const large = Math.abs(a2 - a1) > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const blRatio = total > 0 ? bl / total : 0.5;
  const zones = [
    { from: 0,    to: 0.30, color: '#DC3545' },
    { from: 0.30, to: 0.45, color: '#FF6B6B' },
    { from: 0.45, to: 0.55, color: '#555555' },
    { from: 0.55, to: 0.70, color: '#6BCB77' },
    { from: 0.70, to: 1.00, color: '#28A745' },
  ];

  const angle = toAngle(blRatio);
  const nx = cx + r * 0.78 * Math.cos(angle);
  const ny = cy + r * 0.78 * Math.sin(angle);

  const blN = Number(bl) || 0;
  const ssN = Number(ss) || 0;
  const tot = blN + ssN;
  const ssPct = tot > 0 ? Math.round((ssN / tot) * 100) : 0;
  const blPctVal = tot > 0 ? Math.round((blN / tot) * 100) : 0;
  const dir = tot === 0 ? '—' : ssPct > blPctVal ? `${ssPct}% SS` : blPctVal > ssPct ? `${blPctVal}% BL` : '50/50';
  const dirColor = tot === 0 ? '#555' : ssPct > blPctVal ? '#ff6b6b' : blPctVal > ssPct ? '#6bcb77' : '#aaa';
  const textY = cy - r * 0.55;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        background: highlight ? '#161610' : '#111',
        borderRadius: 10, padding: '8px 4px 8px',
        border: hovered ? '1px solid rgba(255,215,0,0.45)' : highlight ? '1px solid #FFD70033' : '1px solid transparent',
        cursor: onClick ? 'pointer' : 'default',
        transform: hovered && onClick ? 'scale(1.03)' : 'scale(1)',
        filter: hovered && onClick ? 'drop-shadow(0 0 5px rgba(255,215,0,0.25))' : 'none',
        transition: 'transform 0.15s ease, border-color 0.15s ease, filter 0.15s ease',
      }}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <path d={arcPath(Math.PI, 2 * Math.PI)} fill="none" stroke="#1e1e1e" strokeWidth={13} />
        {zones.map((z, i) => (
          <path key={i} d={arcPath(toAngle(z.from), toAngle(z.to))} fill="none" stroke={z.color} strokeWidth={11} opacity={0.75} />
        ))}
        {/* SS (red, left side) — BL (green, right side) matching arc colors */}
        <text x={cx} y={textY} textAnchor="middle" fontFamily="monospace" fontSize={11} fontWeight={700}>
          <tspan fill="#ff6b6b">{ss}</tspan>
          <tspan fill="#444" fontSize={8}>SS </tspan>
          <tspan fill="#6bcb77">{bl}</tspan>
          <tspan fill="#444" fontSize={8}>BL</tspan>
        </text>
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#FFD700" strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={13} fill="#0a0a0a" stroke="#FFD700" strokeWidth={1.5} />
        <image href="/favicon.png" x={cx - 11} y={cy - 11} width={22} height={22} />
      </svg>
      <div style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, textAlign: 'center', lineHeight: 1.2, marginTop: -2, padding: '0 4px' }}>
        {label}{totalStocks > 0 && <span style={{ color: '#666', fontWeight: 500, fontSize: 10, marginLeft: 3 }}>{totalStocks}</span>}
      </div>
      <div style={{ color: dirColor, fontSize: 11, fontWeight: 600, marginTop: 2 }}>{dir}</div>

      {/* New signal ratio bar — left=SS (red), right=BL (green) to match gauge */}
      {(() => {
        const total = newBl + newSs;
        if (total === 0) return (
          <div style={{ width: '90%', height: 16, marginTop: 5, borderRadius: 4, background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#333', fontSize: 9, letterSpacing: 1 }}>NO NEW</span>
          </div>
        );
        const blPct = newBl / total * 100;
        const ssPct = newSs / total * 100;
        return (
          <div style={{ width: '90%', height: 18, marginTop: 5, borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
            {newSs > 0 && (
              <div onClick={e => { e.stopPropagation(); onNewSsClick?.(); }}
                style={{ flex: ssPct, background: '#c0392b', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, cursor: onNewSsClick ? 'pointer' : 'default', transition: 'filter 0.12s' }}
                onMouseEnter={e => { if (onNewSsClick) e.currentTarget.style.filter = 'brightness(1.3)'; }}
                onMouseLeave={e => e.currentTarget.style.filter = 'none'}>
                <span style={{ color: '#fff', fontSize: 10, fontWeight: 800, fontFamily: 'monospace' }}>{newSs}</span>
              </div>
            )}
            {newBl > 0 && (
              <div onClick={e => { e.stopPropagation(); onNewBlClick?.(); }}
                style={{ flex: blPct, background: '#28a745', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, cursor: onNewBlClick ? 'pointer' : 'default', transition: 'filter 0.12s' }}
                onMouseEnter={e => { if (onNewBlClick) e.currentTarget.style.filter = 'brightness(1.3)'; }}
                onMouseLeave={e => e.currentTarget.style.filter = 'none'}>
                <span style={{ color: '#fff', fontSize: 10, fontWeight: 800, fontFamily: 'monospace' }}>{newBl}</span>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

const ALIASES = {
  'Consumer Defensive': 'Consumer Staples',
  'Consumer Discretionary': 'Consumer Cyclical',
};
const SECTOR_CONFIG = [
  { key: 'Technology',             label: 'Technology'            },
  { key: 'Healthcare',             label: 'Healthcare'            },
  { key: 'Financial Services',     label: 'Financials'            },
  { key: 'Industrials',            label: 'Industrials'           },
  { key: 'Consumer Staples',       label: 'Consumer Staples'      },
  { key: 'Energy',                 label: 'Energy'                },
  { key: 'Utilities',              label: 'Utilities'             },
  { key: 'Basic Materials',        label: 'Basic Materials'       },
  { key: 'Communication Services', label: 'Communication'         },
  { key: 'Real Estate',            label: 'Real Estate'           },
  { key: 'Consumer Cyclical',      label: 'Consumer Disc.'        },
  { key: '__ALL__',                label: 'ALL SECTORS'           },
];

// Maps Pulse sector keys to SectorPage ETF tickers (sessionStorage handshake)
const SECTOR_KEY_TO_ETF = {
  'Technology':             'XLK',
  'Healthcare':             'XLV',
  'Financial Services':     'XLF',
  'Industrials':            'XLI',
  'Consumer Staples':       'XLP',
  'Energy':                 'XLE',
  'Utilities':              'XLU',
  'Basic Materials':        'XLB',
  'Communication Services': 'XLC',
  'Real Estate':            'XLRE',
  'Consumer Cyclical':      'XLY',
};

function SectorPulse({ signals, killDataLive, onNavigate, newSignals }) {
  const rawBySector = signals?.bySector || {};
  const rawTotalStocks = signals?.totalStocksBySector || {};
  const bySector = {};
  const totalStocksBySector = {};
  for (const [sector, counts] of Object.entries(rawBySector)) {
    const canonical = ALIASES[sector] || sector;
    if (!bySector[canonical]) bySector[canonical] = { bl: 0, ss: 0 };
    bySector[canonical].bl += counts.bl || 0;
    bySector[canonical].ss += counts.ss || 0;
  }
  for (const [sector, count] of Object.entries(rawTotalStocks)) {
    const canonical = ALIASES[sector] || sector;
    totalStocksBySector[canonical] = (totalStocksBySector[canonical] || 0) + count;
  }

  // Build per-sector new signal counts from newSignals.blStocks / ssStocks
  const newBySector = {};
  // Server pre-filters blStocks/ssStocks to last completed weekly candle only — no client filter needed.
  for (const s of (newSignals?.blStocks || [])) {
    const canonical = ALIASES[s.sector] || s.sector;
    if (!canonical) continue;
    if (!newBySector[canonical]) newBySector[canonical] = { bl: 0, ss: 0 };
    newBySector[canonical].bl++;
  }
  for (const s of (newSignals?.ssStocks || [])) {
    const canonical = ALIASES[s.sector] || s.sector;
    if (!canonical) continue;
    if (!newBySector[canonical]) newBySector[canonical] = { bl: 0, ss: 0 };
    newBySector[canonical].ss++;
  }
  const totalNewBl = (newSignals?.blStocks || []).length;
  const totalNewSs = (newSignals?.ssStocks || []).length;

  const handleSectorClick = (key) => {
    if (key === '__ALL__') {
      onNavigate?.('sectors');
      return;
    }
    const etf = SECTOR_KEY_TO_ETF[key];
    if (etf) sessionStorage.setItem('pnthr-sector-etf', etf);
    onNavigate?.('sectors');
  };

  return (
    <div style={{ flex: 1, minWidth: 600, background: '#111', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, letterSpacing: 2 }}>⚡ PNTHR SECTOR PULSE</span>
        {killDataLive === false && <span style={{ color: '#555', fontSize: 10, background: '#1a1a1a', padding: '1px 6px', borderRadius: 4 }}>Fri pipeline</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6 }}>
        {SECTOR_CONFIG.map(({ key, label }) => {
          const d = key === '__ALL__'
            ? { bl: signals?.blCount || 0, ss: signals?.ssCount || 0 }
            : (bySector[key] || { bl: 0, ss: 0 });
          const nd = key === '__ALL__'
            ? { bl: totalNewBl, ss: totalNewSs }
            : (newBySector[key] || { bl: 0, ss: 0 });
          const ts = key === '__ALL__'
            ? Object.values(totalStocksBySector).reduce((a, b) => a + b, 0)
            : (totalStocksBySector[key] || 0);
          return (
            <PNTHRMiniGauge
              key={key}
              label={label}
              bl={d.bl}
              ss={d.ss}
              newBl={nd.bl}
              newSs={nd.ss}
              totalStocks={ts}
              highlight={key === '__ALL__'}
              onClick={() => handleSectorClick(key)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── New Signals This Week Panel ────────────────────────────────────────────────
function NewSignalsPanel({ newSignals, onTickerClick, analyzeContext, universeLabel }) {
  if (!newSignals) return null;
  const { blStocks = [], blEtfs = [], ssStocks = [], ssEtfs = [] } = newSignals;
  const hasStocks = blStocks.length > 0 || ssStocks.length > 0;
  const hasEtfs   = blEtfs.length > 0 || ssEtfs.length > 0;
  if (!hasStocks && !hasEtfs) return (
    <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12, color: '#444', fontSize: 12, fontFamily: 'monospace' }}>
      <span style={{ color: '#FFD700', letterSpacing: 2, fontSize: 11 }}>⚡ {universeLabel ? `${universeLabel} ` : ''}NEW SIGNALS THIS WEEK</span>
      <span style={{ marginLeft: 16 }}>No new signals this week.</span>
    </div>
  );

  // Separate chart lists: stocks-only for BL/SS columns, ETF-only for ETF box
  function toChartItem(s) { return { ticker: s.ticker, symbol: s.ticker, currentPrice: s.currentPrice, signal: s.signal, sector: s.sector }; }
  const blStockChartList = blStocks.map(toChartItem);
  const ssStockChartList = ssStocks.map(toChartItem);
  const blEtfChartList   = blEtfs.map(toChartItem);
  const ssEtfChartList   = ssEtfs.map(toChartItem);

  // ── Stock row (Kill-scored + RSI, no tier badge) ──
  function StockRow({ s, idx, chartList }) {
    const ar = analyzeContext ? computeAnalyzeScore(s, analyzeContext) : null;
    const hasRsi = s.rsiCurrent != null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px', borderBottom: '1px solid #1a1a1a', cursor: 'pointer', transition: 'background 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        onClick={() => onTickerClick(chartList, idx)}
      >
        <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, minWidth: 50, fontFamily: 'monospace' }}>{s.ticker}</span>
        <span style={{ color: '#555', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sector || '—'}</span>
        <span style={{ color: '#ccc', fontSize: 12, minWidth: 70, textAlign: 'right', fontFamily: 'monospace' }}>{s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}</span>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: 12, minWidth: 44, textAlign: 'right', fontFamily: 'monospace' }}>{s.totalScore != null ? s.totalScore.toFixed(1) : '—'}</span>
        {hasRsi ? (
          <span style={{ fontSize: 10, fontFamily: 'monospace', minWidth: 100, textAlign: 'right', letterSpacing: 0.3 }} title={`RSI(14) — Low: ${s.rsiLow}  Current: ${s.rsiCurrent}  High: ${s.rsiHigh}`}>
            <span style={{ color: '#FFD700' }}>{s.rsiLow}</span>
            <span style={{ color: '#333' }}> · </span>
            <span style={{ color: '#fff', fontWeight: 700 }}>{s.rsiCurrent}</span>
            <span style={{ color: '#333' }}> · </span>
            <span style={{ color: '#6bcb77' }}>{s.rsiHigh}</span>
          </span>
        ) : (
          <span style={{ fontSize: 10, fontFamily: 'monospace', minWidth: 100, textAlign: 'right', color: '#333' }}>— · — · —</span>
        )}
        {ar && <span style={{ color: ar.color, fontSize: 11, fontWeight: 700, fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }} title={ar.warnings?.length ? ar.warnings[0] : `Pre-trade: ${ar.pct}%`}>{ar.pct}{ar.warnings?.length > 0 ? '⚠' : ''}</span>}
        <span style={{ color: '#FFD700', fontSize: 11 }}>▸</span>
      </div>
    );
  }

  // ── Sticky column header row ──
  function ColumnHeaders() {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px', borderBottom: '1px solid #333', position: 'sticky', top: 0, background: '#151515', zIndex: 2 }}>
        <span style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 50, fontFamily: 'monospace' }}>TICKER</span>
        <span style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: 1, flex: 1, fontFamily: 'monospace' }}>SECTOR</span>
        <span style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 70, textAlign: 'right', fontFamily: 'monospace' }}>PRICE</span>
        <span style={{ color: '#666', fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 44, textAlign: 'right', fontFamily: 'monospace' }}>SCORE</span>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, minWidth: 100, textAlign: 'right', fontFamily: 'monospace' }}>
          <span style={{ color: '#FFD700' }}>L</span><span style={{ color: '#444' }}> · </span><span style={{ color: '#ccc' }}>C</span><span style={{ color: '#444' }}> · </span><span style={{ color: '#6bcb77' }}>H</span><span style={{ color: '#555', marginLeft: 4 }}>RSI</span>
        </span>
        <span style={{ minWidth: 32 }} />
        <span style={{ minWidth: 11 }} />
      </div>
    );
  }

  // ── Stock column (BL or SS) — stocks only, no ETFs ──
  function StockColumn({ direction, stocks, chartList }) {
    const borderColor = direction === 'BL' ? '#28a745' : '#dc3545';
    const headerBg    = direction === 'BL' ? 'rgba(40,167,69,0.12)' : 'rgba(220,53,69,0.12)';
    const badgeColor  = direction === 'BL' ? '#6bcb77' : '#ff6b6b';
    const label       = direction === 'BL' ? 'NEW BUY LONG (BL+1)' : 'NEW SELL SHORT (SS+1)';
    return (
      <div style={{ flex: 1, minWidth: 0, border: `1px solid ${borderColor}33`, borderLeft: `3px solid ${borderColor}`, borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ background: headerBg, padding: '6px 10px', flexShrink: 0 }}>
          <span style={{ color: badgeColor, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>{label}</span>
          <span style={{ color: '#444', fontSize: 10, marginLeft: 8 }}>STOCKS ({stocks.length})</span>
        </div>
        {stocks.length > 0 ? (
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            <ColumnHeaders />
            {stocks.map((s, i) => <StockRow key={s.ticker} s={s} idx={i} chartList={chartList} />)}
          </div>
        ) : (
          <div style={{ padding: '10px 14px', color: '#333', fontSize: 12 }}>No new {direction} signals this week.</div>
        )}
      </div>
    );
  }

  // ── ETF row (no Kill score — show price + category + ▸) ──
  function EtfRow({ s, idx, chartList }) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #222', cursor: 'pointer', transition: 'background 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,215,0,0.04)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        onClick={() => onTickerClick(chartList, idx)}
      >
        <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 12, width: 52, fontFamily: 'monospace', flexShrink: 0 }}>{s.ticker}</span>
        <span style={{ color: '#888', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sector || '—'}</span>
        <span style={{ color: '#e8e8e8', fontSize: 12, minWidth: 72, textAlign: 'right', fontFamily: 'monospace', flexShrink: 0 }}>
          {s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}
        </span>
        <span style={{ color: '#FFD700', marginLeft: 10, fontSize: 11, flexShrink: 0 }}>▸</span>
      </div>
    );
  }

  // ── ETF box (full width, yellow top border) ──
  function EtfBox() {
    if (!hasEtfs) return null;
    return (
      <div style={{ background: '#1e1e1e', border: '1px solid #333', borderTop: '2px solid #FFD700', borderRadius: 6, padding: '12px 16px', marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ color: '#FFD700', fontFamily: 'monospace', fontWeight: 700, fontSize: 12, letterSpacing: 1 }}>⚡ ETF NEW SIGNALS</span>
          <span style={{ background: '#FFD700', color: '#000', fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 3, letterSpacing: 1 }}>ETF</span>
          <span style={{ color: '#555', fontSize: 11 }}>
            BL+1 ({blEtfs.length}) | SS+1 ({ssEtfs.length})
          </span>
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          {/* BL ETFs */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#28a745', fontSize: 11, fontWeight: 700, borderBottom: '1px solid #28a74544', paddingBottom: 5, marginBottom: 8 }}>
              BL+1 ETFs ({blEtfs.length})
            </div>
            {blEtfs.length > 0
              ? blEtfs.map((s, i) => <EtfRow key={s.ticker} s={s} idx={i} chartList={blEtfChartList} />)
              : <div style={{ color: '#444', fontSize: 11, fontStyle: 'italic' }}>No new BL ETF signals</div>
            }
          </div>
          {/* SS ETFs */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#dc3545', fontSize: 11, fontWeight: 700, borderBottom: '1px solid #dc354544', paddingBottom: 5, marginBottom: 8 }}>
              SS+1 ETFs ({ssEtfs.length})
            </div>
            {ssEtfs.length > 0
              ? ssEtfs.map((s, i) => <EtfRow key={s.ticker} s={s} idx={i} chartList={ssEtfChartList} />)
              : <div style={{ color: '#444', fontSize: 11, fontStyle: 'italic' }}>No new SS ETF signals</div>
            }
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12 }}>
      {/* Header: Stocks counts | ETFs counts */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ color: '#FFD700', fontSize: 11, letterSpacing: 2, fontFamily: 'monospace', fontWeight: 700 }}>⚡ {universeLabel ? `${universeLabel} ` : ''}NEW SIGNALS THIS WEEK</span>
        <span style={{ color: '#444', fontSize: 11 }}>Stocks:</span>
        <span style={{ color: '#6bcb77', fontSize: 11, fontWeight: 700 }}>{blStocks.length} BL+1</span>
        <span style={{ color: '#333', fontSize: 11 }}>|</span>
        <span style={{ color: '#ff6b6b', fontSize: 11, fontWeight: 700 }}>{ssStocks.length} SS+1</span>
        {hasEtfs && <>
          <span style={{ color: '#333', fontSize: 11, margin: '0 4px' }}>·</span>
          <span style={{ color: '#444', fontSize: 11 }}>ETFs:</span>
          <span style={{ color: '#6bcb77', fontSize: 11, fontWeight: 700 }}>{blEtfs.length} BL+1</span>
          <span style={{ color: '#333', fontSize: 11 }}>|</span>
          <span style={{ color: '#ff6b6b', fontSize: 11, fontWeight: 700 }}>{ssEtfs.length} SS+1</span>
        </>}
      </div>
      {/* Stock columns */}
      <div style={{ display: 'flex', gap: 12 }}>
        <StockColumn direction="BL" stocks={blStocks} chartList={blStockChartList} />
        <StockColumn direction="SS" stocks={ssStocks} chartList={ssStockChartList} />
      </div>
      {/* ETF box — full width, below stocks, hidden when empty */}
      <EtfBox />
    </div>
  );
}

// ── Sector abbreviations for compact display ──────────────────────────────────
const SECTOR_ABBREV = {
  'Technology':             'Tech',
  'Healthcare':             'Health',
  'Financial Services':     'Fin',
  'Industrials':            'Ind',
  'Consumer Staples':       'ConStap',
  'Consumer Defensive':     'ConStap',
  'Energy':                 'Energy',
  'Utilities':              'Util',
  'Basic Materials':        'BasMat',
  'Communication Services': 'CommSvc',
  'Real Estate':            'RealEst',
  'Consumer Cyclical':      'ConDisc',
  'Consumer Discretionary': 'ConDisc',
};
function abbrevSector(sector) {
  if (!sector || sector === '—') return '—';
  return SECTOR_ABBREV[sector] || sector.slice(0, 8);
}

// ── Developing Signals Panel ───────────────────────────────────────────────────
function DevelopingSignalsPanel({ devSignals, loading, onTickerClick, analyzeContext }) {
  const status = devSignals?.status;
  const bl = devSignals?.bl || [];
  const ss = devSignals?.ss || [];
  const triggeredToday = devSignals?.triggeredToday || { bl: [], ss: [] };
  const hasTriggered = triggeredToday.bl.length > 0 || triggeredToday.ss.length > 0;
  const hasAny = bl.length > 0 || ss.length > 0;

  // CSS for pulsing "developing" animation and triggered rows (injected once)
  const pulseStyle = `
    @keyframes devPulse {
      0%, 100% { opacity: 0.85; }
      50% { opacity: 1; }
    }
    .dev-bl-row { animation: devPulse 2.5s ease-in-out infinite; background: rgba(40,167,69,0.04); }
    .dev-ss-row { animation: devPulse 2.5s ease-in-out infinite; background: rgba(220,53,69,0.04); }
    .dev-bl-row:hover { background: rgba(40,167,69,0.1) !important; animation: none; }
    .dev-ss-row:hover { background: rgba(220,53,69,0.1) !important; animation: none; }
    .trig-bl-row { background: rgba(40,167,69,0.1); border-left: 3px solid #28a745; }
    .trig-ss-row { background: rgba(220,53,69,0.1); border-left: 3px solid #dc3545; }
    .trig-bl-row:hover { background: rgba(40,167,69,0.18) !important; }
    .trig-ss-row:hover { background: rgba(220,53,69,0.18) !important; }
  `;

  function TriggeredRow({ s, dir, idx, chartList }) {
    const isBL = dir === 'BL';
    const accentColor = isBL ? '#6bcb77' : '#ff6b6b';
    const rowClass = isBL ? 'trig-bl-row' : 'trig-ss-row';
    return (
      <div
        className={rowClass}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          borderBottom: '1px solid #1a1a1a', cursor: 'pointer', transition: 'background 0.15s' }}
        onClick={() => onTickerClick(chartList, idx)}
      >
        <span style={{ background: accentColor, color: '#000', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, letterSpacing: 1, flexShrink: 0 }}>
          {isBL ? 'BL' : 'SS'}
        </span>
        <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, minWidth: 52, fontFamily: 'monospace' }}>{s.ticker}</span>
        <span style={{ color: '#555', fontSize: 11, minWidth: 58, maxWidth: 58, flexShrink: 0, whiteSpace: 'nowrap' }}>{abbrevSector(s.sector)}</span>
        <span style={{ color: accentColor, fontSize: 11, flex: 1, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>
          ✓ TRIGGERED TODAY
        </span>
        <span style={{ color: accentColor, fontSize: 11, flexShrink: 0 }}>▸</span>
      </div>
    );
  }

  function DevRow({ s, dir, idx, chartList }) {
    const isBL = dir === 'BL';
    const rowClass = isBL ? 'dev-bl-row' : 'dev-ss-row';
    const accentColor = isBL ? '#6bcb77' : '#ff6b6b';
    const devStock = { ...s, signal: dir, isDeveloping: true, currentPrice: s.price };
    const ar = analyzeContext ? computeAnalyzeScore(devStock, analyzeContext) : null;

    // Proximity label — negative pct means price has ALREADY passed last week's high/low
    const pct = isBL ? s.pctFromHigh : s.pctFromLow;
    const pastLevel = pct < 0;
    let proximityLabel, proximityColor;
    if (isBL) {
      proximityLabel = pastLevel
        ? `▲ PAST ${Math.abs(pct).toFixed(1)}% past last wk high`
        : `${pct.toFixed(1)}% from last wk high`;
      proximityColor = pastLevel ? '#FFD700' : accentColor;
    } else {
      proximityLabel = pastLevel
        ? `▼ PAST ${Math.abs(pct).toFixed(1)}% past last wk low`
        : `${pct.toFixed(1)}% from last wk low`;
      proximityColor = pastLevel ? '#FFD700' : accentColor;
    }

    return (
      <div
        className={rowClass}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          borderBottom: '1px solid #1a1a1a', cursor: 'pointer', transition: 'background 0.15s',
          // Gold left accent for stocks that have already passed the trigger level
          borderLeft: pastLevel ? `3px solid #FFD700` : undefined,
        }}
        onClick={() => onTickerClick(chartList, idx)}
      >
        {/* DEV badge */}
        <span style={{ border: `1px dashed ${accentColor}88`, color: accentColor, fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, letterSpacing: 1, flexShrink: 0 }}>
          DEV
        </span>
        <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, minWidth: 52, fontFamily: 'monospace' }}>{s.ticker}</span>
        <span style={{ color: '#555', fontSize: 11, minWidth: 58, maxWidth: 58, flexShrink: 0, whiteSpace: 'nowrap' }}>{abbrevSector(s.sector)}</span>
        <span style={{ color: '#ccc', fontSize: 12, minWidth: 60, textAlign: 'right', fontFamily: 'monospace' }}>${(+s.price).toFixed(2)}</span>
        {/* Proximity to trigger level */}
        <span style={{ color: proximityColor, fontSize: 11, flex: 1, textAlign: 'right', fontFamily: 'monospace', fontWeight: pastLevel ? 700 : 400 }}>
          {proximityLabel}
        </span>
        {/* Week direction confirmation */}
        <span style={{ color: isBL ? '#6bcb7799' : '#ff6b6b99', fontSize: 10, minWidth: 54, textAlign: 'right', flexShrink: 0 }}>
          {isBL ? 'Week ↑ ✓' : 'Week ↓ ✓'}
        </span>
        {ar && (
          <span style={{ color: ar.color, fontSize: 10, fontWeight: 700, fontFamily: 'monospace', flexShrink: 0 }} title={ar.warnings?.length ? ar.warnings[0] : `Pre-trade: ${ar.pct}%`}>
            {ar.pct}{ar.warnings?.length > 0 ? '⚠' : ''}
          </span>
        )}
        <span style={{ color: accentColor, fontSize: 11, flexShrink: 0 }}>▸</span>
      </div>
    );
  }

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12 }}>
      <style>{pulseStyle}</style>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ color: '#FFD700', fontSize: 11, letterSpacing: 2, fontFamily: 'monospace', fontWeight: 700 }}>
          ⏳ DEVELOPING SIGNALS
        </span>
        <span style={{ background: 'rgba(255,215,0,0.1)', border: '1px solid #FFD70044', color: '#FFD700', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3, letterSpacing: 1 }}>
          3 OF 4 CONDITIONS MET
        </span>
        {!loading && (hasAny || hasTriggered) && (
          <>
            {hasTriggered && (
              <>
                <span style={{ background: 'rgba(255,215,0,0.35)', border: '1px solid #FFD70066', color: '#FFD700', fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 3, letterSpacing: 1 }}>
                  ✓ TRIGGERED
                </span>
                <span style={{ color: '#6bcb77', fontSize: 11, fontWeight: 700 }}>{triggeredToday.bl.length} BL</span>
                <span style={{ color: '#ff6b6b', fontSize: 11, fontWeight: 700 }}>{triggeredToday.ss.length} SS</span>
                {hasAny && <span style={{ color: '#333', fontSize: 11 }}>·</span>}
              </>
            )}
            {hasAny && (
              <>
                <span style={{ color: '#444', fontSize: 11 }}>Developing:</span>
                <span style={{ color: '#6bcb77', fontSize: 11, fontWeight: 700 }}>{bl.length} BL</span>
                <span style={{ color: '#333', fontSize: 11 }}>|</span>
                <span style={{ color: '#ff6b6b', fontSize: 11, fontWeight: 700 }}>{ss.length} SS</span>
              </>
            )}
          </>
        )}
        {loading && <span style={{ color: '#555', fontSize: 11 }}>Scanning...</span>}
        {!loading && status === 'COLD' && (
          <span style={{ color: '#555', fontSize: 11 }}>Signal cache warming — check back in ~2 min</span>
        )}
        {!loading && status === 'OK' && !hasAny && (
          <span style={{ color: '#444', fontSize: 11 }}>No developing signals detected</span>
        )}
        <span style={{ marginLeft: 'auto', color: '#333', fontSize: 10 }}>
          ⏳ awaiting Friday weekly close
        </span>
      </div>

      {loading && (
        <div style={{ color: '#444', fontSize: 12, padding: '8px 10px' }}>
          Analyzing intra-week conditions...
        </div>
      )}

      {/* ── TRIGGERED TODAY ── daily job confirmed signal on today's developing candle */}
      {!loading && hasTriggered && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#FFD700', fontSize: 10, letterSpacing: 2, fontFamily: 'monospace', fontWeight: 700, marginBottom: 6 }}>
            ✓ TRIGGERED TODAY — weekly signal confirmed at today's close
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0, border: '1px solid #28a74555', borderLeft: '3px solid #28a745', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ background: 'rgba(40,167,69,0.12)', padding: '5px 10px' }}>
                <span style={{ color: '#6bcb77', fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>NEW BL</span>
                <span style={{ color: '#555', fontSize: 10, marginLeft: 8 }}>({triggeredToday.bl.length}) crossed signal threshold today</span>
              </div>
              {triggeredToday.bl.length > 0
                ? (() => {
                    const chartList = triggeredToday.bl.map(s => ({ ticker: s.ticker, symbol: s.ticker, companyName: '', exchange: '', currentPrice: null, signal: 'BL', sector: s.sector }));
                    return triggeredToday.bl.map((s, i) => <TriggeredRow key={s.ticker} s={s} dir="BL" idx={i} chartList={chartList} />);
                  })()
                : <div style={{ padding: '10px 14px', color: '#333', fontSize: 12 }}>None</div>
              }
            </div>
            <div style={{ flex: 1, minWidth: 0, border: '1px solid #dc354555', borderLeft: '3px solid #dc3545', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ background: 'rgba(220,53,69,0.12)', padding: '5px 10px' }}>
                <span style={{ color: '#ff6b6b', fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>NEW SS</span>
                <span style={{ color: '#555', fontSize: 10, marginLeft: 8 }}>({triggeredToday.ss.length}) crossed signal threshold today</span>
              </div>
              {triggeredToday.ss.length > 0
                ? (() => {
                    const chartList = triggeredToday.ss.map(s => ({ ticker: s.ticker, symbol: s.ticker, companyName: '', exchange: '', currentPrice: null, signal: 'SS', sector: s.sector }));
                    return triggeredToday.ss.map((s, i) => <TriggeredRow key={s.ticker} s={s} dir="SS" idx={i} chartList={chartList} />);
                  })()
                : <div style={{ padding: '10px 14px', color: '#333', fontSize: 12 }}>None</div>
              }
            </div>
          </div>
        </div>
      )}

      {/* ── DEVELOPING (3 of 4 conditions met) ── */}
      {!loading && hasAny && (
        <div style={{ display: 'flex', gap: 12 }}>
          {/* BL Column */}
          <div style={{ flex: 1, minWidth: 0, border: '1px solid #28a74533', borderLeft: '3px solid #28a745', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ background: 'rgba(40,167,69,0.08)', padding: '5px 10px' }}>
              <span style={{ color: '#6bcb77', fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>DEVELOPING BL</span>
              <span style={{ color: '#444', fontSize: 10, marginLeft: 8 }}>({bl.length}) slope ↑ · near last wk high · week trending ↑</span>
            </div>
            {bl.length > 0
              ? (() => {
                  const chartList = bl.map(s => ({ ticker: s.ticker, symbol: s.ticker, companyName: s.companyName || '', exchange: s.exchange || '', currentPrice: s.price, signal: 'BL', sector: s.sector }));
                  return bl.map((s, i) => <DevRow key={s.ticker} s={s} dir="BL" idx={i} chartList={chartList} />);
                })()
              : <div style={{ padding: '10px 14px', color: '#333', fontSize: 12 }}>No developing BL signals</div>
            }
          </div>
          {/* SS Column */}
          <div style={{ flex: 1, minWidth: 0, border: '1px solid #dc354533', borderLeft: '3px solid #dc3545', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ background: 'rgba(220,53,69,0.08)', padding: '5px 10px' }}>
              <span style={{ color: '#ff6b6b', fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>DEVELOPING SS</span>
              <span style={{ color: '#444', fontSize: 10, marginLeft: 8 }}>({ss.length}) slope ↓ · near last wk low · week trending ↓</span>
            </div>
            {ss.length > 0
              ? (() => {
                  const chartList = ss.map(s => ({ ticker: s.ticker, symbol: s.ticker, companyName: s.companyName || '', exchange: s.exchange || '', currentPrice: s.price, signal: 'SS', sector: s.sector }));
                  return ss.map((s, i) => <DevRow key={s.ticker} s={s} dir="SS" idx={i} chartList={chartList} />);
                })()
              : <div style={{ padding: '10px 14px', color: '#333', fontSize: 12 }}>No developing SS signals</div>
            }
          </div>
        </div>
      )}
    </div>
  );
}

function MoversPanel({ movers, onTickerClick }) {
  if (!movers) {
    return (
      <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12, color: '#666', fontSize: 12 }}>
        Loading PNTHR Movers...
      </div>
    );
  }
  const stocks = movers.stocks || { gainers: [], decliners: [] };
  const etfs = movers.etfs || { gainers: [], decliners: [] };

  // Single combined chart list — click any row to scroll through all 34 with arrows.
  const combined = [
    ...stocks.gainers,
    ...stocks.decliners,
    ...etfs.gainers,
    ...etfs.decliners,
  ].map(r => ({ ticker: r.ticker, companyName: r.name }));
  const indexOf = (ticker) => combined.findIndex(c => c.ticker === ticker);

  const Clickable = ({ rows, kind }) => {
    const isGain = kind === 'gainers';
    const color = isGain ? '#16a34a' : '#dc2626';
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.changePct || 0)), 0) || 1;
    if (!rows || rows.length === 0) return <div style={{ color: '#666', fontSize: 12, padding: '8px 0' }}>—</div>;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(r => {
          const pct = r.changePct ?? 0;
          const widthPct = Math.max(2, (Math.abs(pct) / maxAbs) * 100);
          return (
            <div
              key={r.ticker}
              onClick={() => onTickerClick?.(combined, indexOf(r.ticker))}
              style={{ display: 'grid', gridTemplateColumns: '60px 1fr 80px 70px 1fr', gap: 8, alignItems: 'center', fontSize: 12, cursor: 'pointer', padding: '2px 4px', borderRadius: 4 }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#1a1a1a'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ color: '#D4A017', fontWeight: 700, letterSpacing: 0.5 }}>{r.ticker}</div>
              <div style={{ color: '#bbb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{r.name}</div>
              <div style={{ color: '#eee', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {r.price >= 1000 ? r.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : r.price.toFixed(2)}
              </div>
              <div style={{ color, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{pct >= 0 ? '+' : ''}{pct.toFixed(3)}%</div>
              <div style={{ position: 'relative', height: 16, background: '#1a1a1a', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${widthPct}%`, height: '100%', background: color, transition: 'width 200ms' }} />
                {r.signalLabel && (
                  <div style={{
                    position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
                    background: '#fff', color: '#000', fontWeight: 700, fontSize: 9,
                    letterSpacing: 0.3, padding: '1px 4px', borderRadius: 2, lineHeight: 1.2,
                    fontFamily: 'monospace', boxShadow: '0 0 0 1px rgba(0,0,0,0.3)'
                  }}>
                    {r.signalLabel}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '14px 18px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ color: '#D4A017', fontSize: 13, letterSpacing: 2, fontWeight: 700 }}>📈 PNTHR MOVERS</div>
        <div style={{ color: '#666', fontSize: 10 }}>
          {movers.asOf ? `as of ${new Date(movers.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 480 }}>
          <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>Carnivore STOCKS</div>
          <div style={{ color: '#16a34a', fontSize: 10, letterSpacing: 1.5, marginBottom: 4 }}>TOP GAINERS</div>
          <div style={{ marginBottom: 12 }}><Clickable rows={stocks.gainers} kind="gainers" /></div>
          <div style={{ color: '#dc2626', fontSize: 10, letterSpacing: 1.5, marginBottom: 4 }}>TOP DECLINERS</div>
          <Clickable rows={stocks.decliners} kind="decliners" />
        </div>
        <div style={{ flex: 1, minWidth: 480 }}>
          <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>PNTHR ETFs</div>
          <div style={{ color: '#16a34a', fontSize: 10, letterSpacing: 1.5, marginBottom: 4 }}>TOP GAINERS</div>
          <div style={{ marginBottom: 12 }}><Clickable rows={etfs.gainers} kind="gainers" /></div>
          <div style={{ color: '#dc2626', fontSize: 10, letterSpacing: 1.5, marginBottom: 4 }}>TOP DECLINERS</div>
          <Clickable rows={etfs.decliners} kind="decliners" />
        </div>
      </div>
    </div>
  );
}

function SignalBreadthBar({ signals, onSignalClick }) {
  const [hovBl, setHovBl] = useState(false);
  const [hovSs, setHovSs] = useState(false);
  const bl = signals?.blCount || 0, ss = signals?.ssCount || 0;
  const total = bl + ss;
  const blPct = total > 0 ? (bl / total) * 100 : 50;

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ color: '#888', fontSize: 11, letterSpacing: 2, marginBottom: 8 }}>⚡ SIGNAL BREADTH</div>
      <div style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
        <div
          onClick={() => onSignalClick?.('BL')}
          onMouseEnter={() => setHovBl(true)}
          onMouseLeave={() => setHovBl(false)}
          style={{ width: `${blPct}%`, background: '#28a745', opacity: hovBl ? 1 : 0.7, cursor: 'pointer', transition: 'opacity 0.15s' }}
        />
        <div
          onClick={() => onSignalClick?.('SS')}
          onMouseEnter={() => setHovSs(true)}
          onMouseLeave={() => setHovSs(false)}
          style={{ width: `${100 - blPct}%`, background: '#dc3545', opacity: hovSs ? 1 : 0.7, cursor: 'pointer', transition: 'opacity 0.15s' }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#ccc' }}>
        <span
          onClick={() => onSignalClick?.('BL')}
          style={{ color: '#6bcb77', cursor: 'pointer', fontWeight: 700, textDecoration: 'underline', textDecorationColor: 'rgba(107,203,119,0.4)' }}
        >{bl} BL</span>
        <span style={{ color: '#888', fontSize: 11 }}>Ratio: {(signals?.ratio || 0).toFixed(1)}:1 SS:BL</span>
        <span
          onClick={() => onSignalClick?.('SS')}
          style={{ color: '#ff6b6b', cursor: 'pointer', fontWeight: 700, textDecoration: 'underline', textDecorationColor: 'rgba(255,107,107,0.4)' }}
        >{ss} SS</span>
      </div>
    </div>
  );
}

// ── Signal Stock Drill-Down Modal ──────────────────────────────────────────────
const TIER_BADGE = {
  'ALPHA PNTHR KILL': { bg: 'rgba(212,160,23,0.25)', color: '#FFD700' },
  'STRIKING':         { bg: 'rgba(40,167,69,0.2)',   color: '#6bcb77' },
  'HUNTING':          { bg: 'rgba(32,120,55,0.2)',   color: '#4a9',   },
  'POUNCING':         { bg: 'rgba(20,160,140,0.2)',  color: '#4dd',   },
  'COILING':          { bg: 'rgba(30,100,180,0.2)',  color: '#69b',   },
  'STALKING':         { bg: 'rgba(80,80,120,0.2)',   color: '#99a',   },
};

function tierBadge(tier) {
  if (!tier) return null;
  const key = Object.keys(TIER_BADGE).find(k => tier.includes(k)) || null;
  const { bg, color } = key ? TIER_BADGE[key] : { bg: '#1a1a1a', color: '#666' };
  const short = tier.includes('ALPHA') ? 'ALPHA' : tier.split(' ')[0];
  return <span style={{ background: bg, color, fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>{short}</span>;
}

const SORT_COLS = ['ticker', 'sector', 'currentPrice', 'totalScore', 'tier', 'signalAge'];

function SignalStockModal({ signal, onClose, onTickerClick }) {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('totalScore');
  const [sortDir, setSortDir] = useState(-1); // -1 = desc, 1 = asc

  useEffect(() => {
    setLoading(true);
    fetchSignalStocks(signal)
      .then(data => setStocks(data.stocks || []))
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, [signal]);

  const sorted = [...stocks].sort((a, b) => {
    const av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
    if (typeof av === 'number') return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d * -1);
    else { setSortCol(col); setSortDir(-1); }
  };

  const isBL = signal === 'BL';
  const headerColor = isBL ? '#6bcb77' : '#ff6b6b';
  const headerBg = isBL ? 'rgba(40,167,69,0.12)' : 'rgba(220,53,69,0.12)';

  const ColHeader = ({ col, label }) => (
    <th
      onClick={() => handleSort(col)}
      style={{ padding: '8px 10px', textAlign: 'left', color: sortCol === col ? '#FFD700' : '#666', fontWeight: 700, fontSize: 11, letterSpacing: 1, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}{sortCol === col ? (sortDir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#0f0f0f', border: `1px solid ${headerColor}33`, borderRadius: 12, width: '100%', maxWidth: 860, maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #1a1a1a', background: headerBg, borderRadius: '12px 12px 0 0' }}>
          <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 14, letterSpacing: 2 }}>
            ⚡ {loading ? '...' : sorted.length} {isBL ? 'BUY LONG (BL)' : 'SELL SHORT (SS)'} SIGNALS
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Table */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ color: '#555', textAlign: 'center', padding: 40, fontSize: 13 }}>Loading signals...</div>
          ) : sorted.length === 0 ? (
            <div style={{ color: '#555', textAlign: 'center', padding: 40, fontSize: 13 }}>No {signal} signals in current data.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#0f0f0f', borderBottom: '1px solid #222' }}>
                <tr>
                  <ColHeader col="ticker" label="TICKER" />
                  <ColHeader col="sector" label="SECTOR" />
                  <ColHeader col="currentPrice" label="PRICE" />
                  <ColHeader col="totalScore" label="KILL SCORE" />
                  <ColHeader col="tier" label="TIER" />
                  <ColHeader col="signalAge" label="AGE" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((s, i) => (
                  <tr key={s.ticker} style={{ borderBottom: '1px solid #111', background: i % 2 === 0 ? 'transparent' : '#0a0a0a' }}>
                    <td style={{ padding: '7px 10px' }}>
                      <span
                        onClick={() => {
                          const chartStocks = sorted.map(x => ({ ticker: x.ticker, symbol: x.ticker, currentPrice: x.currentPrice, signal, sector: x.sector }));
                          onTickerClick(chartStocks, i);
                        }}
                        style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(212,160,23,0.4)' }}
                      >{s.ticker}</span>
                    </td>
                    <td style={{ padding: '7px 10px', color: '#888', fontSize: 12 }}>{s.sector || '—'}</td>
                    <td style={{ padding: '7px 10px', color: '#ccc', fontSize: 12 }}>{s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}</td>
                    <td style={{ padding: '7px 10px', color: '#fff', fontWeight: 700, fontSize: 13 }}>{s.totalScore?.toFixed(1) ?? '—'}</td>
                    <td style={{ padding: '7px 10px' }}>{tierBadge(s.tier)}</td>
                    <td style={{ padding: '7px 10px', color: '#555', fontSize: 11 }}>{s.signalAge != null ? `${s.signalAge}w` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {!loading && sorted.length > 0 && (
          <div style={{ padding: '10px 20px', borderTop: '1px solid #1a1a1a', color: '#555', fontSize: 11, textAlign: 'right' }}>
            Sorted by {sortCol} {sortDir === -1 ? '↓' : '↑'} · Click column headers to sort · Click ticker for chart
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// AI 300 SPECIFIC SUB-COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════

function Ai300RegimeStrip({ regime, signals, positions, pai300 }) {
  const isBull = regime?.pai300Bull === true;
  const isBear = regime?.pai300Bull === false;
  const label = isBear ? 'BEARISH' : isBull ? 'BULLISH' : 'NEUTRAL';
  const labelColor = isBear ? '#ff6b6b' : isBull ? '#6bcb77' : '#888';
  const borderColor = isBear ? '#dc3545' : isBull ? '#28a745' : '#555';
  const bg = isBear ? 'rgba(220,53,69,0.07)' : isBull ? 'rgba(40,167,69,0.07)' : 'rgba(100,100,100,0.07)';
  const ssD1 = regime?.ssD1 ?? null;
  const blD1 = regime?.blD1 ?? null;
  const ratio = regime?.signalRatio ?? null;
  const heat = positions?.heat;
  const nav = positions?.nav ?? 100000;
  const capacity = heat ? ((0.15 * nav) - heat.totalRisk).toFixed(0) : null;

  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      background: bg, border: `1px solid ${borderColor}33`, borderLeft: `3px solid ${borderColor}`,
      borderRadius: 4, padding: '9px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ color: labelColor, fontWeight: 900, fontSize: 15, fontFamily: 'monospace', letterSpacing: 2 }}>
          ⚡ AI 300 {label}
        </span>
        {ssD1 !== null && blD1 !== null ? (
          <span style={{ fontSize: 12 }}>
            <span style={{ color: '#ff6b6b', fontWeight: 700 }}>SS {ssD1.toFixed(2)}×</span>
            <span style={{ color: '#333', margin: '0 6px' }}>|</span>
            <span style={{ color: '#6bcb77', fontWeight: 700 }}>BL {blD1.toFixed(2)}×</span>
          </span>
        ) : null}
        <span style={{ color: '#555', fontSize: 11 }}>
          {ratio !== null ? `SS:BL ${ratio.toFixed(1)}:1` : ''}
        </span>
        <span style={{ fontSize: 11 }}>
          <span style={{ color: isBear ? '#ff6b6b' : isBull ? '#6bcb77' : '#888' }}>
            PAI300 {pai300?.value ? pai300.value.toFixed(1) : '—'} {isBear ? '▼' : isBull ? '▲' : '–'}
          </span>
          {pai300?.ema21W && (
            <span style={{ color: '#444', marginLeft: 6 }}>
              36W EMA {pai300.ema21W.toFixed(1)}
            </span>
          )}
        </span>
      </div>
      {heat && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <span style={{ color: '#555', fontSize: 11 }}>
            Stk {heat.stockRiskPct?.toFixed(1)}%/10%
          </span>
          <span style={{ color: '#FFD700', fontWeight: 700, fontSize: 13, fontFamily: 'monospace' }}>
            Heat: {heat.totalRiskPct?.toFixed(1)}% / 15%
          </span>
          {capacity && (
            <span style={{ color: '#28a745', fontSize: 11 }}>
              ${Number(capacity).toLocaleString()} cap
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const AI_SECTOR_TIER_COLORS = { GO: '#28a745', NEUTRAL: '#FFD700', NO_GO: '#dc3545' };

function Ai300SectorPulse({ signals, sectorTiers, killDataLive, newSignals, onNavigate, allSignalStocks, onSectorStockClick, onNewSignalClick }) {
  const bySector = signals?.bySector || {};
  const totalStocksBySector = signals?.totalStocksBySector || {};

  const newBySector = {};
  for (const s of (newSignals?.blStocks || [])) {
    if (!s.sector) continue;
    if (!newBySector[s.sector]) newBySector[s.sector] = { bl: 0, ss: 0 };
    newBySector[s.sector].bl++;
  }
  for (const s of (newSignals?.ssStocks || [])) {
    if (!s.sector) continue;
    if (!newBySector[s.sector]) newBySector[s.sector] = { bl: 0, ss: 0 };
    newBySector[s.sector].ss++;
  }

  const sectorNames = Object.keys(totalStocksBySector).sort((a, b) => {
    const ra = sectorTiers?.[a]?.rank ?? 99;
    const rb = sectorTiers?.[b]?.rank ?? 99;
    return ra - rb;
  });

  const totalBl = signals?.blCount || 0;
  const totalSs = signals?.ssCount || 0;
  const totalNewBl = (newSignals?.blStocks || []).length;
  const totalNewSs = (newSignals?.ssStocks || []).length;

  return (
    <div style={{ flex: 1, minWidth: 600, background: '#111', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color: '#FFD700', fontSize: 12, fontWeight: 700, letterSpacing: 2 }}>⚡ AI 300 SECTOR PULSE</span>
        {killDataLive === false && <span style={{ color: '#555', fontSize: 10, background: '#1a1a1a', padding: '1px 6px', borderRadius: 4 }}>Fri pipeline</span>}
        <span style={{ color: '#444', fontSize: 10 }}>16 AI sectors</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {/* ALL row first */}
        <PNTHRMiniGauge
          label="ALL SECTORS"
          bl={totalBl} ss={totalSs}
          newBl={totalNewBl} newSs={totalNewSs}
          totalStocks={Object.values(totalStocksBySector).reduce((a, b) => a + b, 0)}
          highlight={true}
          onClick={() => onNavigate?.('aiJungle')}
          onNewBlClick={() => onNewSignalClick?.('BL', null)}
          onNewSsClick={() => onNewSignalClick?.('SS', null)}
        />
        {sectorNames.map(sName => {
          const d = bySector[sName] || { bl: 0, ss: 0 };
          const nd = newBySector[sName] || { bl: 0, ss: 0 };
          const ts = totalStocksBySector[sName] || 0;
          const tier = sectorTiers?.[sName];
          const tierColor = tier ? AI_SECTOR_TIER_COLORS[tier.tier] || '#555' : '#555';
          return (
            <div key={sName} style={{ position: 'relative' }}>
              <PNTHRMiniGauge label={sName} bl={d.bl} ss={d.ss} newBl={nd.bl} newSs={nd.ss} totalStocks={ts} onClick={() => onSectorStockClick?.(sName)}
                onNewBlClick={() => onNewSignalClick?.('BL', sName)}
                onNewSsClick={() => onNewSignalClick?.('SS', sName)} />
              {tier && (
                <span style={{
                  position: 'absolute', top: 4, right: 6, fontSize: 8, fontWeight: 700,
                  color: tierColor, letterSpacing: 0.5, fontFamily: 'monospace',
                }}>
                  #{tier.rank} {tier.tier}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Ai300MoversPanel({ movers, onTickerClick }) {
  if (!movers) {
    return (
      <div style={{ background: '#111', borderRadius: 12, padding: '12px 16px', marginBottom: 12, color: '#666', fontSize: 12 }}>
        Loading AI 300 Movers...
      </div>
    );
  }
  const stocks = movers.stocks || { gainers: [], decliners: [] };
  const combined = [...stocks.gainers, ...stocks.decliners].map(r => ({ ticker: r.ticker, companyName: r.name }));
  const indexOf = (ticker) => combined.findIndex(c => c.ticker === ticker);

  const Clickable = ({ rows, kind }) => {
    const isGain = kind === 'gainers';
    const color = isGain ? '#16a34a' : '#dc2626';
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.changePct || 0)), 0) || 1;
    if (!rows || rows.length === 0) return <div style={{ color: '#666', fontSize: 12, padding: '8px 0' }}>—</div>;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(r => {
          const pct = r.changePct ?? 0;
          const widthPct = Math.max(2, (Math.abs(pct) / maxAbs) * 100);
          return (
            <div key={r.ticker} onClick={() => onTickerClick?.(combined, indexOf(r.ticker))}
              style={{ display: 'grid', gridTemplateColumns: '60px 1fr 80px 70px 1fr', gap: 8, alignItems: 'center', fontSize: 12, cursor: 'pointer', padding: '2px 4px', borderRadius: 4 }}
              onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <div style={{ color: '#D4A017', fontWeight: 700, letterSpacing: 0.5 }}>{r.ticker}</div>
              <div style={{ color: '#bbb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{r.name}</div>
              <div style={{ color: '#eee', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {r.price >= 1000 ? r.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : r.price.toFixed(2)}
              </div>
              <div style={{ color, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{pct >= 0 ? '+' : ''}{pct.toFixed(3)}%</div>
              <div style={{ position: 'relative', height: 16, background: '#1a1a1a', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${widthPct}%`, height: '100%', background: color, transition: 'width 200ms' }} />
                {r.signalLabel && (
                  <div style={{
                    position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
                    background: '#fff', color: '#000', fontWeight: 700, fontSize: 9,
                    letterSpacing: 0.3, padding: '1px 4px', borderRadius: 2, lineHeight: 1.2,
                    fontFamily: 'monospace', boxShadow: '0 0 0 1px rgba(0,0,0,0.3)'
                  }}>{r.signalLabel}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '14px 18px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ color: '#D4A017', fontSize: 13, letterSpacing: 2, fontWeight: 700 }}>📈 AI 300 MOVERS</div>
        <div style={{ color: '#666', fontSize: 10 }}>
          {movers.asOf ? `as of ${new Date(movers.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 480 }}>
          <div style={{ color: '#16a34a', fontSize: 10, letterSpacing: 1.5, marginBottom: 4 }}>TOP GAINERS</div>
          <div style={{ marginBottom: 12 }}><Clickable rows={stocks.gainers} kind="gainers" /></div>
          <div style={{ color: '#dc2626', fontSize: 10, letterSpacing: 1.5, marginBottom: 4 }}>TOP DECLINERS</div>
          <Clickable rows={stocks.decliners} kind="decliners" />
        </div>
      </div>
    </div>
  );
}

function Ai300SignalStockModal({ signal, onClose, onTickerClick }) {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('totalScore');
  const [sortDir, setSortDir] = useState(-1);

  useEffect(() => {
    setLoading(true);
    fetchAi300SignalStocks(signal)
      .then(data => setStocks(data.stocks || []))
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, [signal]);

  const sorted = [...stocks].sort((a, b) => {
    const va = a[sortCol] ?? 0, vb = b[sortCol] ?? 0;
    if (sortCol === 'ticker' || sortCol === 'sector') return sortDir * String(va).localeCompare(String(vb));
    return sortDir * ((+va) - (+vb));
  });

  const chartStocks = sorted.map(s => ({ ticker: s.ticker, symbol: s.ticker, currentPrice: s.currentPrice, signal: s.signal, sector: s.sector }));
  const headerColor = signal === 'BL' ? '#6bcb77' : '#ff6b6b';
  const SORT_COLS_AI = ['ticker', 'sector', 'currentPrice', 'totalScore', 'tier', 'signalAge'];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#111', border: '1px solid rgba(255,215,0,0.25)', borderRadius: 12, padding: '20px 24px', maxWidth: 800, width: '90vw', maxHeight: '80vh', overflow: 'auto', fontFamily: 'monospace' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ color: headerColor, fontWeight: 800, letterSpacing: 2, fontSize: 14 }}>AI 300 {signal === 'BL' ? 'BUY LONG' : 'SELL SHORT'} — {stocks.length} STOCKS</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        {loading ? <div style={{ color: '#666', padding: 20 }}>Loading...</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>{SORT_COLS_AI.map(c => (
                <th key={c} onClick={() => { setSortCol(c); setSortDir(sortCol === c ? -sortDir : -1); }}
                  style={{ textAlign: c === 'ticker' || c === 'sector' ? 'left' : 'right', padding: '6px 8px', color: sortCol === c ? '#FFD700' : '#666', cursor: 'pointer', borderBottom: '1px solid #333', fontWeight: 600 }}>
                  {c === 'currentPrice' ? 'PRICE' : c === 'totalScore' ? 'SCORE' : c === 'signalAge' ? 'AGE' : c.toUpperCase()}
                  {sortCol === c && <span style={{ marginLeft: 4 }}>{sortDir === 1 ? '▲' : '▼'}</span>}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {sorted.map((s, i) => {
                const t = tierBadge(s.tier);
                return (
                  <tr key={s.ticker} style={{ cursor: 'pointer' }}
                    onClick={() => { onTickerClick(chartStocks, i); }}
                    onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '5px 8px', color: '#FFD700', fontWeight: 700 }}>{s.ticker}</td>
                    <td style={{ padding: '5px 8px', color: '#888' }}>{s.sector || '—'}</td>
                    <td style={{ padding: '5px 8px', color: '#ccc', textAlign: 'right' }}>{s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}</td>
                    <td style={{ padding: '5px 8px', color: '#fff', textAlign: 'right', fontWeight: 700 }}>{s.totalScore != null ? s.totalScore.toFixed(1) : '—'}</td>
                    <td style={{ padding: '5px 8px', textAlign: 'right' }}>{t}</td>
                    <td style={{ padding: '5px 8px', color: '#888', textAlign: 'right' }}>{s.signalAge != null ? `${s.signalAge}w` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Ai300NewSignalModal({ signal, sector, newSignals, onClose, onTickerClick }) {
  const source = signal === 'BL' ? (newSignals?.blStocks || []) : (newSignals?.ssStocks || []);
  const filtered = sector ? source.filter(s => s.sector === sector) : source;
  const sorted = [...filtered].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  const chartItems = sorted.map(s => ({ ticker: s.ticker }));
  const headerColor = signal === 'BL' ? '#6bcb77' : '#ff6b6b';
  const dirLabel = signal === 'BL' ? 'BUY LONG' : 'SELL SHORT';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#111', border: '1px solid rgba(255,215,0,0.25)', borderRadius: 12, padding: '20px 24px', maxWidth: 560, width: '90vw', maxHeight: '80vh', overflow: 'auto', fontFamily: 'monospace' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ color: headerColor, fontSize: 14, fontWeight: 800, letterSpacing: 1 }}>
              AI 300 NEW {dirLabel} THIS WEEK
            </div>
            <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>
              {sector ? `${sector} — ` : ''}{sorted.length} stock{sorted.length !== 1 ? 's' : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        {sorted.length === 0 ? (
          <div style={{ color: '#555', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>No new {signal} signals{sector ? ` in ${sector}` : ''} this week.</div>
        ) : (
          sorted.map((s, i) => {
            const t = tierBadge(s.tier);
            return (
              <div key={s.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #1a1a1a', cursor: 'pointer', transition: 'background 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => onTickerClick(chartItems, i)}>
                <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, minWidth: 55, fontFamily: 'monospace' }}>{s.ticker}</span>
                <span style={{ color: '#555', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sector || '—'}</span>
                <span style={{ color: '#ccc', fontSize: 12, minWidth: 65, textAlign: 'right', fontFamily: 'monospace' }}>{s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}</span>
                <span style={{ color: '#fff', fontWeight: 700, fontSize: 12, minWidth: 40, textAlign: 'right', fontFamily: 'monospace' }}>{s.totalScore != null ? s.totalScore.toFixed(1) : '—'}</span>
                <span style={{ minWidth: 80 }}>{t}</span>
                <span style={{ color: '#FFD700', fontSize: 11 }}>▸</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function Ai300SectorStocksModal({ sectorName, allSignalStocks, sectorTier, onClose, onTickerClick }) {
  const sectorStocks = (allSignalStocks || []).filter(s => s.sector === sectorName);
  const blStocks = sectorStocks.filter(s => s.signal === 'BL').sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  const ssStocks = sectorStocks.filter(s => s.signal === 'SS').sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  const allTickers = sectorStocks.map(s => ({ ticker: s.ticker }));

  const tierColor = sectorTier ? (AI_SECTOR_TIER_COLORS[sectorTier.tier] || '#888') : '#888';

  const StockRow = ({ s, idx }) => {
    const t = tierBadge(s.tier);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #1a1a1a', cursor: 'pointer', transition: 'background 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        onClick={() => onTickerClick(allTickers, idx)}>
        <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 13, minWidth: 55, fontFamily: 'monospace' }}>{s.ticker}</span>
        <span style={{ background: s.signal === 'SS' ? 'rgba(220,53,69,0.2)' : 'rgba(40,167,69,0.2)', color: s.signal === 'SS' ? '#ff6b6b' : '#6bcb77', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>{s.signal}</span>
        <span style={{ color: '#ccc', fontSize: 12, minWidth: 65, textAlign: 'right', fontFamily: 'monospace' }}>{s.currentPrice ? `$${(+s.currentPrice).toFixed(2)}` : '—'}</span>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: 12, minWidth: 40, textAlign: 'right', fontFamily: 'monospace' }}>{s.totalScore != null ? s.totalScore.toFixed(1) : '—'}</span>
        <span style={{ minWidth: 80 }}>{t}</span>
        <span style={{ color: '#FFD700', fontSize: 11, marginLeft: 'auto' }}>▸</span>
      </div>
    );
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#111', border: '1px solid rgba(255,215,0,0.25)', borderRadius: 12, padding: '20px 24px', maxWidth: 560, width: '90vw', maxHeight: '80vh', overflow: 'auto', fontFamily: 'monospace' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ color: '#FFD700', fontSize: 16, fontWeight: 700, letterSpacing: 1 }}>{sectorName}</div>
            <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11 }}>
              <span style={{ color: '#6bcb77' }}>{blStocks.length} BL</span>
              <span style={{ color: '#ff6b6b' }}>{ssStocks.length} SS</span>
              <span style={{ color: '#888' }}>{sectorStocks.length} active signals</span>
              {sectorTier && (
                <span style={{ color: tierColor, fontWeight: 700 }}>#{sectorTier.rank} {sectorTier.tier} ({(sectorTier.fiveDayReturn * 100).toFixed(2)}%)</span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {sectorStocks.length === 0 ? (
          <div style={{ color: '#555', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>No active signals in this sector.</div>
        ) : (
          <>
            {blStocks.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: '#28a745', fontSize: 10, letterSpacing: 1.5, fontWeight: 700, padding: '4px 10px', borderBottom: '1px solid #28a74544' }}>BUY LONG ({blStocks.length})</div>
                {blStocks.map((s, i) => <StockRow key={s.ticker} s={s} idx={sectorStocks.indexOf(s)} />)}
              </div>
            )}
            {ssStocks.length > 0 && (
              <div>
                <div style={{ color: '#dc3545', fontSize: 10, letterSpacing: 1.5, fontWeight: 700, padding: '4px 10px', borderBottom: '1px solid #dc354544' }}>SELL SHORT ({ssStocks.length})</div>
                {ssStocks.map((s, i) => <StockRow key={s.ticker} s={s} idx={sectorStocks.indexOf(s)} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Tier 3 sub-components ──────────────────────────────────────────────────────

const SECTOR_SHORT_NAMES = {
  'Communication Services': 'Comm Services',
  'Consumer Discretionary': 'Cons Discret',
  'Consumer Staples':       'Cons Staples',
  'Financial Services':     'Financial Svcs',
  'Information Technology': 'Technology',
  'Basic Materials':        'Materials',
};
function getSectorDisplayName(s) { return SECTOR_SHORT_NAMES[s] || s; }

function MetricCard({ label, value, valueColor, context, showBar, barPct, barColor }) {
  return (
    <div style={{ backgroundColor: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: valueColor || '#e8e6e3', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>{context}</div>
      {showBar && (
        <div style={{ marginTop: 8, height: 4, backgroundColor: '#2a2a2a', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(barPct, 100)}%`, backgroundColor: barColor, borderRadius: 2 }} />
        </div>
      )}
    </div>
  );
}

function AlertStrip({ alerts, lotsReady, onNavigate }) {
  const lotsCount = lotsReady?.length || 0;
  const hasCritical = alerts.some(a => a.level === 'CRITICAL');
  const hasHigh     = alerts.some(a => a.level === 'HIGH');
  const totalAlerts = alerts.length + (lotsCount > 0 ? 1 : 0);

  const level = totalAlerts === 0 ? 'CLEAR' : hasCritical ? 'CRITICAL' : hasHigh ? 'HIGH' : 'NORMAL';
  const cfg = {
    CLEAR:    { bg: 'rgba(40,167,69,0.08)',   border: 'rgba(40,167,69,0.25)',   dot: '#28a745', text: '#28a745', msg: 'No active alerts. All clear.' },
    NORMAL:   { bg: 'rgba(255,215,0,0.08)',   border: 'rgba(255,215,0,0.25)',   dot: '#FFD700', text: '#FFD700', msg: `${lotsCount} lot${lotsCount > 1 ? 's' : ''} READY to fill` },
    HIGH:     { bg: 'rgba(253,126,20,0.08)',  border: 'rgba(253,126,20,0.25)',  dot: '#fd7e14', text: '#fd7e14', msg: `${alerts.length} alert${alerts.length > 1 ? 's' : ''} — action needed` },
    CRITICAL: { bg: 'rgba(220,53,69,0.08)',   border: 'rgba(220,53,69,0.25)',   dot: '#dc3545', text: '#dc3545', msg: `${alerts.length} alert${alerts.length > 1 ? 's' : ''} — immediate action required` },
  }[level];

  return (
    <div style={{ padding: '10px 14px', backgroundColor: cfg.bg, border: `1px solid ${cfg.border}`,
      borderRadius: 8, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: cfg.dot, flexShrink: 0 }} />
      <span style={{ fontSize: 13, color: cfg.text }}>{cfg.msg}</span>
      {lotsCount > 0 && level === 'NORMAL' && (
        <span style={{ fontSize: 11, color: '#555', marginLeft: 4 }}>
          {(lotsReady || []).map(l => `${l.ticker} Lot ${l.lot}`).join(', ')}
        </span>
      )}
      <span onClick={() => { sessionStorage.setItem('openRiskAdvisor', '1'); onNavigate?.('assistant'); }}
        style={{ marginLeft: 'auto', fontSize: 12, color: '#888', cursor: 'pointer',
          textDecoration: 'underline', textDecorationColor: 'rgba(136,136,136,0.3)', textUnderlineOffset: 3 }}>
        View risk advisor →
      </span>
    </div>
  );
}

function SectorCard({ sector, data, onClick }) {
  const isHeightened = data.level === 'HEIGHTENED';
  const isElevated   = data.level === 'ELEVATED';
  const dot     = isHeightened ? '#dc3545' : isElevated ? '#FFD700' : '#28a745';
  const netClr  = isHeightened ? '#dc3545' : isElevated ? '#FFD700' : '#28a745';
  const bg      = isHeightened ? 'rgba(220,53,69,0.06)' : isElevated ? 'rgba(255,215,0,0.04)' : '#1a1a1a';
  const border  = isHeightened ? 'rgba(220,53,69,0.25)' : isElevated ? 'rgba(255,215,0,0.35)' : '#2a2a2a';
  const name    = getSectorDisplayName(sector);

  return (
    <div
      onClick={onClick ? () => onClick(sector, data) : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px',
      backgroundColor: bg, border: `1px solid ${border}`, borderRadius: 6,
      cursor: onClick ? 'pointer' : 'default', transition: 'filter 0.12s ease' }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.filter = 'brightness(1.25)'; }}
      onMouseLeave={e => { if (onClick) e.currentTarget.style.filter = 'none'; }}
      title={`${sector}: ${data.longCount}L / ${data.shortCount}S — net exposure ${data.netExposure} ${data.netDirection}${onClick ? ' (click to view tickers)' : ''}`}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: dot, flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: '#e8e6e3', fontWeight: 600, flex: 1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      <span style={{ fontSize: 11, color: '#888', whiteSpace: 'nowrap' }}>{data.longCount}L/{data.shortCount}S</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: netClr, whiteSpace: 'nowrap' }}>net {data.netExposure}</span>
    </div>
  );
}

function SectorTickersModal({ sector, data, opposites, onClose, onTickerClick }) {
  const longs  = data?.longs  || [];
  const shorts = data?.shorts || [];
  const oppCandidates = opposites?.candidates || [];
  const oppDir        = opposites?.direction || null; // 'BL' / 'SS' / null
  const all = [...longs, ...shorts, ...oppCandidates.map(c => c.ticker)];
  const name = getSectorDisplayName(sector);

  const TickerChip = ({ ticker, dir }) => (
    <button
      onClick={() => onTickerClick?.(ticker, all)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 10px',
        background: '#0a0a0a',
        border: `1px solid ${dir === 'LONG' ? 'rgba(40,167,69,0.45)' : 'rgba(220,53,69,0.45)'}`,
        borderRadius: 6, cursor: 'pointer', fontFamily: 'monospace',
      }}
      onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
      onMouseLeave={e => e.currentTarget.style.background = '#0a0a0a'}
    >
      <span style={{ color: '#FFD700', fontWeight: 800, fontSize: 13 }}>${ticker}</span>
      <span style={{
        background: dir === 'LONG' ? '#28a745' : '#dc3545', color: '#fff',
        fontSize: 9, fontWeight: 800, letterSpacing: 0.3,
        padding: '1px 5px', borderRadius: 3,
      }}>{dir === 'LONG' ? 'L' : 'S'}</span>
    </button>
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#111', border: '1px solid rgba(252,240,0,0.3)', borderRadius: 12,
          padding: '20px 24px', minWidth: 360, maxWidth: 600, maxHeight: '80vh', overflow: 'auto',
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ color: '#FFD700', fontSize: 16, fontWeight: 700, letterSpacing: 1 }}>{name}</div>
            <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>
              {longs.length}L / {shorts.length}S — net {data?.netExposure} {data?.netDirection}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: '#888', fontSize: 22, cursor: 'pointer', lineHeight: 1,
          }}>×</button>
        </div>

        {longs.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: '#28a745', fontSize: 10, letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>LONGS ({longs.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {longs.map(t => <TickerChip key={`L-${t}`} ticker={t} dir="LONG" />)}
            </div>
          </div>
        )}
        {shorts.length > 0 && (
          <div>
            <div style={{ color: '#dc3545', fontSize: 10, letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>SHORTS ({shorts.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {shorts.map(t => <TickerChip key={`S-${t}`} ticker={t} dir="SHORT" />)}
            </div>
          </div>
        )}
        {longs.length === 0 && shorts.length === 0 && (
          <div style={{ color: '#666', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>No positions in this sector.</div>
        )}

        {oppCandidates.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid rgba(255,215,0,0.35)' }}>
            <div style={{ color: '#FFD700', fontSize: 10, letterSpacing: 1.5, marginBottom: 8, fontWeight: 700 }}>
              ⚡ TOP KILL CANDIDATES{oppDir ? ` (${oppDir} — opposite direction to balance)` : ''}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {oppCandidates.map(c => (
                <button
                  key={c.ticker}
                  onClick={() => onTickerClick?.(c.ticker, all)}
                  style={{
                    display: 'grid', gridTemplateColumns: '70px 1fr 60px 70px 50px', gap: 8,
                    alignItems: 'center', padding: '5px 8px',
                    background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 4,
                    cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, textAlign: 'left',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#1a1a1a'}
                  onMouseLeave={e => e.currentTarget.style.background = '#0a0a0a'}
                >
                  <span style={{ color: '#FFD700', fontWeight: 800 }}>${c.ticker}</span>
                  <span style={{ color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.tier || '—'}</span>
                  <span style={{ color: c.signal === 'BL' ? '#28a745' : '#dc3545', fontWeight: 700 }}>{c.signal || ''}</span>
                  <span style={{ color: '#fff', fontWeight: 700, textAlign: 'right' }}>{c.killScore != null ? c.killScore : '—'}</span>
                  <span style={{ color: '#666', textAlign: 'right' }}>{c.signalAge != null ? `${c.signalAge}w` : ''}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectorExposureGrid({ sectorExposure, onSectorClick }) {
  const sorted = Object.entries(sectorExposure)
    .sort(([, a], [, b]) => {
      const order = { HEIGHTENED: 0, ELEVATED: 1, CLEAR: 2 };
      const d = (order[a.level] ?? 2) - (order[b.level] ?? 2);
      return d !== 0 ? d : b.netExposure - a.netExposure;
    });

  return (
    <div>
      <div style={{ fontSize: 12, color: '#888', letterSpacing: '0.06em', marginBottom: 10 }}>SECTOR EXPOSURE</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
        {sorted.map(([sector, data]) => <SectorCard key={sector} sector={sector} data={data} onClick={onSectorClick} />)}
      </div>
    </div>
  );
}

// ── Tier 3: Portfolio Status panel (redesigned) ────────────────────────────────
function PortfolioStatus({ positions, lotsReady, onNavigate, sectorExposure, onSectorClick }) {
  const heat = positions?.heat || {};
  const nav  = positions?.nav  || 100000;

  const stockPct = heat.stockRiskPct || 0;
  const etfPct   = heat.etfRiskPct   || 0;
  const totalPct = heat.totalRiskPct || 0;
  const remaining = Math.max(0, 15 - totalPct);
  const capacityLeft = Math.round(remaining / 100 * nav);

  // Build alert list for AlertStrip
  const alerts = [];
  if (stockPct > 10) alerts.push({ level: 'CRITICAL', text: `Stock heat ${stockPct.toFixed(1)}% exceeds 10% cap` });
  if (etfPct   > 5)  alerts.push({ level: 'CRITICAL', text: `ETF heat ${etfPct.toFixed(1)}% exceeds 5% cap` });
  if (totalPct > 13) alerts.push({ level: 'HIGH',     text: `Total heat ${totalPct.toFixed(1)}% approaching 15% cap` });
  if (sectorExposure?.recommendations) {
    for (const r of sectorExposure.recommendations) {
      alerts.push({ level: r.level === 'HEIGHTENED' ? 'CRITICAL' : 'HIGH', text: r.sector });
    }
  }

  // Status dot color
  const hasCrit  = alerts.some(a => a.level === 'CRITICAL');
  const hasHigh  = alerts.some(a => a.level === 'HIGH');
  const dotColor = hasCrit ? '#dc3545' : hasHigh ? '#FFD700' : '#28a745';

  const totalHeatColor = totalPct < 10 ? '#28a745' : totalPct < 13 ? '#FFD700' : '#dc3545';

  return (
    <div style={{ background: '#111', borderRadius: 12, padding: '16px 20px', marginTop: 12 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: dotColor }} />
          <span style={{ color: '#FFD700', fontSize: 15, fontWeight: 700, letterSpacing: '0.06em' }}>
            PNTHR PORTFOLIO STATUS
          </span>
        </div>
        <button onClick={() => onNavigate?.('assistant')}
          style={{ fontSize: 12, padding: '4px 12px', backgroundColor: 'transparent',
            border: '1px solid rgba(255,215,0,0.3)', borderRadius: 5, color: '#FFD700', cursor: 'pointer' }}>
          GO TO ASSISTANT →
        </button>
      </div>

      {/* Four metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        <MetricCard
          label="Active"
          value={positions?.total || 0}
          context={`${positions?.long || 0} long · ${positions?.short || 0} short`}
        />
        <MetricCard
          label="Portfolio heat"
          value={`${totalPct.toFixed(1)}%`}
          valueColor={totalHeatColor}
          context="of 15% max"
          showBar barPct={(totalPct / 15) * 100} barColor={totalHeatColor}
        />
        <MetricCard
          label="Recycled"
          value={positions?.recycled || 0}
          valueColor="#28a745"
          context="$0 risk positions"
        />
        <MetricCard
          label="Capacity left"
          value={`$${capacityLeft.toLocaleString()}`}
          context={`stk ${stockPct.toFixed(1)}/10% · ETF ${etfPct.toFixed(1)}/5%`}
        />
      </div>

      {/* Dual heat breakdown bars */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16,
        padding: '8px 14px', backgroundColor: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#888', marginBottom: 4 }}>
            <span>Stock heat: {stockPct.toFixed(1)}%</span><span>10% cap</span>
          </div>
          <div style={{ height: 6, backgroundColor: '#2a2a2a', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 3,
              width: `${Math.min((stockPct / 10) * 100, 100)}%`,
              backgroundColor: stockPct < 7 ? '#28a745' : stockPct < 9 ? '#FFD700' : '#dc3545' }} />
          </div>
        </div>
        <div style={{ width: 1, height: 28, backgroundColor: '#333' }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#888', marginBottom: 4 }}>
            <span>ETF heat: {etfPct.toFixed(1)}%</span><span>5% cap</span>
          </div>
          <div style={{ height: 6, backgroundColor: '#2a2a2a', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 3,
              width: `${Math.min((etfPct / 5) * 100, 100)}%`,
              backgroundColor: etfPct < 3 ? '#28a745' : etfPct < 4.5 ? '#FFD700' : '#dc3545' }} />
          </div>
        </div>
      </div>

      {/* Alert strip */}
      <AlertStrip alerts={alerts} lotsReady={lotsReady} onNavigate={onNavigate} />

      {/* Sector exposure grid */}
      {sectorExposure?.exposure && Object.keys(sectorExposure.exposure).length > 0 && (
        <SectorExposureGrid sectorExposure={sectorExposure.exposure} onSectorClick={onSectorClick} />
      )}
    </div>
  );
}

function SectorPerformanceChart({ data }) {
  if (!data || !data.sectors || data.sectors.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: '#666', fontSize: 12, padding: '16px 0', fontFamily: 'monospace' }}>
        Loading sector performance...
      </div>
    );
  }
  const sectors = data.sectors;
  const maxAbs = Math.max(...sectors.map(s => Math.abs(s.fiveDayReturn)), 1);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ color: '#D4A017', fontSize: 13, letterSpacing: 2, fontWeight: 700 }}>📊 SECTOR PERFORMANCE — 5 DAY</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 10, color: '#888' }}>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#D4A017', marginRight: 4, verticalAlign: 'middle' }} />679</span>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: '#3b82f6', marginRight: 4, verticalAlign: 'middle' }} />AI 300</span>
        </div>
      </div>
      {data.asOf && (
        <div style={{ fontSize: 10, color: '#555', marginBottom: 8 }}>
          as of {new Date(data.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {sectors.map((s, i) => {
          const pct = s.fiveDayReturn;
          const barWidth = Math.min(Math.abs(pct) / maxAbs * 100, 100);
          const isPositive = pct >= 0;
          const is679 = s.universe === '679';
          const barColor = is679 ? '#D4A017' : '#3b82f6';
          const tagBg = is679 ? 'rgba(212,160,23,0.15)' : 'rgba(59,130,246,0.15)';
          const tagColor = is679 ? '#D4A017' : '#60a5fa';
          return (
            <div key={`${s.universe}-${s.name}`} style={{ display: 'grid', gridTemplateColumns: '24px 200px 1fr 58px', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 11 }}>
              <span style={{ color: '#555', textAlign: 'right', fontWeight: 600 }}>{i + 1}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                <span style={{ fontSize: 8, fontWeight: 700, padding: '1px 4px', borderRadius: 2, background: tagBg, color: tagColor, flexShrink: 0 }}>
                  {is679 ? '679' : 'AI'}
                </span>
                <span style={{ color: '#ccc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.name}
                </span>
              </div>
              <div style={{ height: 10, background: '#1a1a2e', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
                <div style={{
                  position: 'absolute',
                  [isPositive ? 'left' : 'right']: 0,
                  top: 0, bottom: 0,
                  width: `${barWidth}%`,
                  background: barColor,
                  borderRadius: 3,
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <span style={{ textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: isPositive ? '#22c55e' : '#ef4444' }}>
                {isPositive ? '+' : ''}{pct.toFixed(2)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
