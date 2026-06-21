// server/ai300KillBackfill.js
// ── PNTHR AI 300 Kill 10 — Deterministic Track-Record Engine ────────────────────
//
// Single source of truth for BOTH the Kill 10 History (case studies) and the
// Kill Test (appearances) track records. Productionized, idempotent version of:
//   server/scripts/backfillAi300KillHistory.js          (case studies)
//   server/scripts/backfillAi300KillTestAppearances.js  (appearances)
//
// It walks every Friday from inception (2022-12-02) through today, re-runs the
// AI Kill D1–D4 formula on the stored weekly candles, and reconstructs the
// case studies + appearances EXACTLY as the original backfills did — using only
// real recorded market data (no fabrication, fully reproducible).
//
// Why this replaces the old live incremental cron updaters:
//   The old daily updaters (checkAi300CaseStudyEntries / updateAi300KillAppearances)
//   read the latest AI Kill score doc with `sort:{scoredAt:-1}` — but no such field
//   exists, so they silently re-read a STALE doc and froze the whole track record
//   from ~2026-05-22 (no new entries, prices stuck at entry, holdingWeeks inflated).
//   A single deterministic engine cannot drift like two divergent code paths can.
//
// Usage:
//   import { rebuildAi300Kill } from './ai300KillBackfill.js';
//   await rebuildAi300Kill({ dryRun: true });            // preview, writes nothing
//   await rebuildAi300Kill({ part: 'both' });            // real rebuild (with backup)
//
// Run modes: dryRun computes + returns a summary but writes nothing.
//            A real run first copies each collection to <coll>_bak (rolling backup).

import { connectToDatabase } from './database.js';

// ── Config (identical to the original backfill scripts) ─────────────────────────
const START_DATE        = '2022-12-02'; // first Friday after AI Universe inception
const TOP_N             = 10;           // case studies: top N ranked enter
const CS_COOLDOWN_WEEKS = 2;            // case studies: re-entry cooldown
const KILL_THRESHOLD    = 80;           // appearances: HUNTING+ qualifies
const NAV               = 100000;
const RISK_PCT          = 1;
const AP_COOLDOWN_WEEKS = 8;            // appearances: re-entry cooldown
const AI_GATE_OFFSET    = 0.25;

const STRIKE_PCT  = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS = [0,    0.03, 0.06, 0.10, 0.14];

const CASE_STUDIES = 'pnthr_ai300_kill_case_studies';
const TRACK_RECORD = 'pnthr_ai300_kill_track_record';
const APPEARANCES  = 'pnthr_ai300_kill_appearances';

// ── AI Kill scoring (mirrors aiKillService.js + the backfill scripts) ───────────
function scoreD1(direction, pai300Bull) {
  if (pai300Bull == null) return 1.0;
  if (direction === 'LONG'  &&  pai300Bull) return 1.30;
  if (direction === 'SHORT' && !pai300Bull) return 1.30;
  if (direction === 'LONG'  && !pai300Bull) return 0.70;
  if (direction === 'SHORT' &&  pai300Bull) return 0.70;
  return 1.0;
}
function scoreD2(direction, tier) {
  if (!tier) return 0;
  if (direction === 'LONG') {
    if (tier === 'GO') return 15;
    if (tier === 'NEUTRAL') return 5;
    if (tier === 'NO_GO') return -15;
  } else {
    if (tier === 'NO_GO') return 15;
    if (tier === 'NEUTRAL') return 5;
    if (tier === 'GO') return -15;
  }
  return 0;
}
function scoreD3(direction, close, ema, emaSlopeAnnPct, riskPct) {
  if (close == null || ema == null || ema <= 0) return 0;
  const sepPct = ((close - ema) / ema) * 100;
  let conviction = direction === 'LONG' ? sepPct : -sepPct;
  conviction = Math.max(0, Math.min(25, conviction));
  const convictionPts = conviction * 2.0;
  let slope = direction === 'LONG' ? (emaSlopeAnnPct ?? 0) : -(emaSlopeAnnPct ?? 0);
  slope = Math.max(0, Math.min(50, slope));
  const slopePts = slope * 0.6;
  let sepBonus = 0;
  if (riskPct != null && riskPct > 0 && riskPct <= 5) sepBonus = 5;
  else if (riskPct != null && riskPct <= 10) sepBonus = 3;
  else if (riskPct != null && riskPct <= 20) sepBonus = 1;
  return convictionPts + slopePts + sepBonus;
}
function scoreD4(signalDate, isNewSignal, weekOf) {
  if (isNewSignal) return 10;
  if (!signalDate) return 0;
  const sigMs = Date.parse(signalDate + 'T00:00:00Z');
  const wkMs  = Date.parse(weekOf + 'T00:00:00Z');
  if (isNaN(sigMs) || isNaN(wkMs)) return 0;
  const ageWeeks = Math.max(0, Math.round((wkMs - sigMs) / (7 * 86400000)));
  return Math.max(-15, -ageWeeks);
}

const TIER_LADDER = [
  { min: 130, name: 'ALPHA AI KILL' },
  { min: 100, name: 'STRIKING' },
  { min: 80,  name: 'HUNTING' },
  { min: 65,  name: 'POUNCING' },
  { min: 50,  name: 'COILING' },
  { min: 35,  name: 'STALKING' },
  { min: 20,  name: 'TRACKING' },
  { min: 10,  name: 'PROWLING' },
  { min: 0,   name: 'STIRRING' },
  { min: -Infinity, name: 'DORMANT' },
];
function getTier(score) {
  return TIER_LADDER.find(t => score >= t.min)?.name ?? 'DORMANT';
}

// ── Signal detection (inline, identical to the backfill scripts) ────────────────
function calculateEMA(bars, period) {
  if (bars.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = bars.slice(0, period).reduce((sum, d) => sum + d.close, 0) / period;
  result.push({ time: bars[period - 1].time, value: parseFloat(ema.toFixed(4)) });
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    result.push({ time: bars[i].time, value: parseFloat(ema.toFixed(4)) });
  }
  return result;
}
function computeWilderATR(bars, period = 3) {
  const n = bars.length;
  const atrArr = new Array(n).fill(null);
  if (n < period + 1) return atrArr;
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur = bars[i], prev = bars[i - 1];
    trs[i] = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  atrArr[period] = atr;
  for (let i = period + 1; i < n; i++) {
    atr = (atr * 2 + trs[i]) / 3;
    atrArr[i] = atr;
  }
  return atrArr;
}
function detectAllSignals(bars, period, isETF = false, dPctOverride = null, gateOffset = 0.10) {
  if (bars.length < period + 2) return { events: [], pnthrStop: null, activeType: null, currentSignal: null };
  const emaData = calculateEMA(bars, period);
  const atrArr  = computeWilderATR(bars);
  const events  = [];
  let position = null;
  let longDaylight = 0, shortDaylight = 0;
  let longTrendActive = false, longTrendCapped = false;
  let shortTrendActive = false, shortTrendCapped = false;

  for (let wi = period + 1; wi < bars.length; wi++) {
    const emaIdx = wi - (period - 1);
    if (emaIdx < 1) continue;
    const current = bars[wi], prev1 = bars[wi - 1], prev2 = bars[wi - 2];
    const emaCurrent = emaData[emaIdx].value;
    const twoBarHigh = Math.max(prev1.high, prev2.high);
    const twoBarLow  = Math.min(prev1.low,  prev2.low);

    longDaylight  = current.low  > emaCurrent ? longDaylight + 1 : 0;
    shortDaylight = current.high < emaCurrent ? shortDaylight + 1 : 0;

    if (position && position.entryWi !== wi) {
      const prevAtr = atrArr[wi - 1];
      if (prevAtr != null) {
        if (position.type === 'BL') {
          const structStop = parseFloat((twoBarLow - 0.01).toFixed(2));
          const atrFloor   = parseFloat((prev1.close - prevAtr).toFixed(2));
          const candidate  = Math.max(structStop, atrFloor);
          position.pnthrStop = parseFloat(Math.max(position.pnthrStop, candidate).toFixed(2));
        } else {
          const structStop = parseFloat((twoBarHigh + 0.01).toFixed(2));
          const atrCeiling = parseFloat((prev1.close + prevAtr).toFixed(2));
          const candidate  = Math.min(structStop, atrCeiling);
          position.pnthrStop = parseFloat(Math.min(position.pnthrStop, candidate).toFixed(2));
        }
      }
      if (position.type === 'BL') {
        if (current.low < twoBarLow) {
          events.push({ time: current.time, signal: 'BE' });
          shortTrendActive = true; shortTrendCapped = true;
          position = null; continue;
        }
      } else {
        if (current.high > twoBarHigh) {
          events.push({ time: current.time, signal: 'SE' });
          longTrendActive = true; longTrendCapped = true;
          position = null; continue;
        }
      }
    }

    if (!position) {
      const emaPrev  = emaData[emaIdx - 1].value;
      const blPhase1 = current.close > emaCurrent && emaCurrent > emaPrev && current.high >= twoBarHigh + 0.01;
      const ssPhase1 = current.close < emaCurrent && emaCurrent < emaPrev && current.low  <= twoBarLow  - 0.01;
      const dPct = dPctOverride != null ? dPctOverride : (isETF ? 0.003 : 0.01);
      const blZone   = current.low  >= emaCurrent * (1 + dPct) && current.low  <= emaCurrent * (1 + gateOffset);
      const ssZone   = current.high <= emaCurrent * (1 - dPct) && current.high >= emaCurrent * (1 - gateOffset);
      const blReentry    = longTrendActive  && current.low  >= emaCurrent * (1 + dPct) && (!longTrendCapped  || current.low  <= emaCurrent * 1.25);
      const ssReentry    = shortTrendActive && current.high <= emaCurrent * (1 - dPct) && (!shortTrendCapped || current.high >= emaCurrent * 0.75);
      const blDaylightOk = blReentry || (blZone && longDaylight  >= 1 && longDaylight  <= 3);
      const ssDaylightOk = ssReentry || (ssZone && shortDaylight >= 1 && shortDaylight <= 3);

      if (blPhase1 && blDaylightOk) {
        const entryPrice = parseFloat((twoBarHigh + 0.01).toFixed(2));
        const initStop   = parseFloat((twoBarLow  - 0.01).toFixed(2));
        events.push({ time: current.time, signal: 'BL', entryPrice, stopPrice: initStop });
        position = { type: 'BL', entryPrice, pnthrStop: initStop, entryWi: wi };
        shortTrendActive = false; shortTrendCapped = false;
      } else if (ssPhase1 && ssDaylightOk) {
        const entryPrice = parseFloat((twoBarLow  - 0.01).toFixed(2));
        const initStop   = parseFloat((twoBarHigh + 0.01).toFixed(2));
        events.push({ time: current.time, signal: 'SS', entryPrice, stopPrice: initStop });
        position = { type: 'SS', entryPrice, pnthrStop: initStop, entryWi: wi };
        longTrendActive = false; longTrendCapped = false;
      }
    }
  }

  return {
    events,
    pnthrStop: position?.pnthrStop ?? null,
    activeType: position?.type ?? null,
    currentSignal: events.length > 0 ? events[events.length - 1].signal : null,
  };
}

// ── Lot sizing helpers (mirror killTestSettings.js) ─────────────────────────────
function serverSizePosition({ nav, entryPrice, stopPrice, riskPct = 1 }) {
  if (!entryPrice || !stopPrice || !nav || nav <= 0) return null;
  const tickerCap = nav * 0.10;
  const vitality  = nav * (riskPct / 100);
  const rps       = Math.abs(entryPrice - stopPrice);
  if (rps <= 0) return null;
  const totalShares = Math.floor(Math.min(Math.floor(vitality / rps), Math.floor(tickerCap / entryPrice)));
  if (totalShares <= 0) return null;
  return { totalShares, maxRiskDollar: +(totalShares * rps).toFixed(2) };
}
function buildServerLotConfig(totalShares, entryPrice, signal) {
  const isShort = signal === 'SS';
  return STRIKE_PCT.map((pct, i) => ({
    lotNum:       i + 1,
    targetShares: Math.max(1, Math.round(totalShares * pct)),
    pct:          pct * 100,
    triggerPrice: isShort
      ? +(entryPrice * (1 - LOT_OFFSETS[i])).toFixed(2)
      : +(entryPrice * (1 + LOT_OFFSETS[i])).toFixed(2),
    offsetPct:    LOT_OFFSETS[i] * 100,
  }));
}
function computeRatchetedStop(lotFills, initialStop, signal) {
  if (!lotFills) return initialStop;
  const isShort = signal === 'SS';
  let cumCost = 0, cumShr = 0, filledCount = 0;
  for (let n = 1; n <= 5; n++) {
    const lot = lotFills[`lot${n}`];
    if (lot?.filled && lot?.fillPrice != null) {
      const shares = lot.shares || 1;
      cumCost += shares * lot.fillPrice;
      cumShr  += shares;
      filledCount++;
    }
  }
  if (filledCount < 2 || cumShr === 0) return initialStop;
  const avgCost = +(cumCost / cumShr).toFixed(2);
  if (isShort) return Math.min(avgCost, initialStop);
  else          return Math.max(avgCost, initialStop);
}

// ── Inputs: load candles, regime, sector ranks; precompute per-Friday scores ────
async function loadInputs(db) {
  const { SECTORS } = await import('./scripts/aiUniverse/aiUniverseData.js');
  const { SECTOR_EMA_PERIODS } = await import('./data/pnthrAiSectorsConfig.js');

  const TICKER_META = {};
  for (const sec of SECTORS) for (const h of sec.holdings) TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name };
  const tickers = Object.keys(TICKER_META);

  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const weeklyByTicker = {};
  for (const d of weeklyDocs) weeklyByTicker[d.ticker] = [...(d.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf));

  const paiDoc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
  const paiWeekly = (paiDoc?.weekly || []).slice().sort((a, b) => a.weekOf.localeCompare(b.weekOf));

  const sectorRankDocs = await db.collection('pnthr_ai_sector_rank_daily').find({}).sort({ date: 1 }).toArray();
  const sectorRankByDate = {};
  for (const doc of sectorRankDocs) {
    const byId = {};
    for (const r of (doc.ranks || [])) byId[r.sectorId] = r.tier;
    sectorRankByDate[doc.date] = byId;
  }
  const sectorRankDates = Object.keys(sectorRankByDate).sort();
  function getSectorTierOn(sectorId, date) {
    for (let i = sectorRankDates.length - 1; i >= 0; i--) {
      if (sectorRankDates[i] <= date) return sectorRankByDate[sectorRankDates[i]]?.[sectorId] ?? null;
    }
    return null;
  }

  function getClosePrice(ticker, date) {
    const wk = weeklyByTicker[ticker];
    if (!wk || wk.length === 0) return null;
    for (let i = wk.length - 1; i >= 0; i--) if (wk[i].weekOf <= date) return wk[i].close;
    return null;
  }
  function getWeeklyBar(ticker, date) {
    const wk = weeklyByTicker[ticker];
    if (!wk) return null;
    for (let i = wk.length - 1; i >= 0; i--) if (wk[i].weekOf <= date) return wk[i];
    return null;
  }

  // Friday list: START_DATE → today (UTC), exactly as the scripts
  const fridays = [];
  const today = new Date().toISOString().split('T')[0];
  let d = new Date(START_DATE + 'T12:00:00Z');
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  while (d.toISOString().split('T')[0] <= today) {
    fridays.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 7);
  }

  const REGIME_PERIOD = 36;
  function pai300BullAt(weekOf) {
    const barsUpTo = paiWeekly.filter(b => b.weekOf <= weekOf);
    if (barsUpTo.length < REGIME_PERIOD) return null;
    const closes = barsUpTo.map(b => b.close);
    const k = 2 / (REGIME_PERIOD + 1);
    let ema = closes.slice(0, REGIME_PERIOD).reduce((s, x) => s + x, 0) / REGIME_PERIOD;
    for (let i = REGIME_PERIOD; i < closes.length; i++) ema = (closes[i] - ema) * k + ema;
    return closes[closes.length - 1] > ema;
  }

  // Precompute the ranked scored list for every Friday (shared by both rebuilds)
  const scoredByFriday = {};
  for (const friday of fridays) {
    const pai300Bull = pai300BullAt(friday);
    const scored = [];
    for (const ticker of tickers) {
      const meta   = TICKER_META[ticker];
      const period = SECTOR_EMA_PERIODS[meta.sectorId] || 30;
      const wk     = weeklyByTicker[ticker] || [];
      const barsUpTo = wk.filter(b => b.weekOf <= friday);
      if (barsUpTo.length < period + 2) continue;

      const wBars = barsUpTo.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close }));
      const { events, pnthrStop, activeType } = detectAllSignals(wBars, period, false, null, AI_GATE_OFFSET);
      if (!activeType || (activeType !== 'BL' && activeType !== 'SS')) continue;

      const direction = activeType === 'BL' ? 'LONG' : 'SHORT';
      const lastBar   = barsUpTo[barsUpTo.length - 1];
      const close     = lastBar.close;

      let signalDate = null, isNewSignal = false;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].signal === activeType) { signalDate = events[i].time; isNewSignal = events[i].time === lastBar.weekOf; break; }
      }

      const emaArr = calculateEMA(wBars, period);
      let ema = null, emaSlopeAnn = null, riskPct = null;
      if (emaArr.length > 0) {
        ema = emaArr[emaArr.length - 1].value;
        if (emaArr.length >= 9) {
          const ema0 = emaArr[emaArr.length - 9].value;
          const ema8 = emaArr[emaArr.length - 1].value;
          if (ema0 > 0) emaSlopeAnn = ((ema8 - ema0) / ema0) * (52 / 8) * 100;
        }
      }
      if (close != null && pnthrStop != null) {
        const r = direction === 'LONG' ? (close - pnthrStop) : (pnthrStop - close);
        if (r > 0) riskPct = (r / close) * 100;
      }

      const sectorTier = getSectorTierOn(meta.sectorId, friday);
      const d1 = scoreD1(direction, pai300Bull);
      const d2 = scoreD2(direction, sectorTier);
      const d3 = scoreD3(direction, close, ema, emaSlopeAnn, riskPct);
      const d4 = scoreD4(signalDate, isNewSignal, friday);
      const total = +((d2 + d3 + d4) * d1).toFixed(2);

      scored.push({
        ticker, signal: activeType, direction,
        sectorName: meta.sectorName, sectorId: meta.sectorId,
        currentPrice: close, stopPrice: pnthrStop,
        signalDate, isNewSignal,
        total, tierName: getTier(total),
        scores: { d1, d2: +d2.toFixed(1), d3: +d3.toFixed(1), d4 },
      });
    }
    scored.sort((a, b) => b.total - a.total || b.scores.d3 - a.scores.d3);
    scored.forEach((s, i) => { s.killRank = i + 1; });
    const scoredMap = {};
    for (const s of scored) scoredMap[s.ticker] = s;
    scoredByFriday[friday] = { scored, scoredMap, pai300Bull };
  }

  return { fridays, scoredByFriday, getClosePrice, getWeeklyBar };
}

// ── Rolling backup: copy a collection to <coll>_bak (server-side, atomic-ish) ────
async function backupCollection(db, name) {
  try {
    const count = await db.collection(name).countDocuments();
    if (count === 0) return { backedUp: 0, into: null };
    await db.collection(name).aggregate([{ $match: {} }, { $out: `${name}_bak` }]).toArray();
    return { backedUp: count, into: `${name}_bak` };
  } catch (err) {
    throw new Error(`Backup of ${name} failed: ${err.message}`);
  }
}

// ── Track-record aggregate (identical shape to ai300KillHistory.js) ─────────────
function buildTrackRecord(allStudies, asOf) {
  const closed = allStudies.filter(s => s.status === 'CLOSED');
  const active = allStudies.filter(s => s.status === 'ACTIVE');
  const winners    = closed.filter(s => (s.pnlPct ?? 0) > 0);
  const losers     = closed.filter(s => (s.pnlPct ?? 0) <= 0);
  const bigWinners = closed.filter(s => (s.pnlPct ?? 0) >= 20);
  const grossWins   = winners.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0);
  const grossLosses = Math.abs(losers.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0));

  const byTier = {};
  for (const s of closed) {
    const t = s.entryTier || 'UNKNOWN';
    if (!byTier[t]) byTier[t] = { count: 0, wins: 0, totalPnl: 0 };
    byTier[t].count++; if ((s.pnlPct ?? 0) > 0) byTier[t].wins++; byTier[t].totalPnl += (s.pnlPct ?? 0);
  }
  for (const t of Object.keys(byTier)) {
    byTier[t].winRate = +(byTier[t].wins / byTier[t].count * 100).toFixed(1);
    byTier[t].avgPnl  = +(byTier[t].totalPnl / byTier[t].count).toFixed(1);
    delete byTier[t].totalPnl;
  }
  const byDirection = {};
  for (const dir of ['SHORT', 'LONG']) {
    const dt = closed.filter(s => s.direction === dir);
    const dw = dt.filter(s => (s.pnlPct ?? 0) > 0);
    byDirection[dir] = {
      count: dt.length,
      winRate: dt.length > 0 ? +(dw.length / dt.length * 100).toFixed(1) : 0,
      avgPnl: dt.length > 0 ? +(dt.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / dt.length).toFixed(1) : 0,
    };
  }
  const bySector = {};
  for (const s of closed) {
    const sec = s.sector || 'Unknown';
    if (!bySector[sec]) bySector[sec] = { count: 0, wins: 0, totalPnl: 0 };
    bySector[sec].count++; if ((s.pnlPct ?? 0) > 0) bySector[sec].wins++; bySector[sec].totalPnl += (s.pnlPct ?? 0);
  }
  for (const sec of Object.keys(bySector)) {
    bySector[sec].winRate = +(bySector[sec].wins / bySector[sec].count * 100).toFixed(1);
    bySector[sec].avgPnl  = +(bySector[sec].totalPnl / bySector[sec].count).toFixed(1);
    delete bySector[sec].totalPnl;
  }
  const byMonth = {};
  for (const s of closed) {
    const month = s.exitDate?.substring(0, 7);
    if (!month) continue;
    if (!byMonth[month]) byMonth[month] = { trades: 0, totalPnl: 0 };
    byMonth[month].trades++; byMonth[month].totalPnl += (s.pnlPct ?? 0);
  }
  const monthlyReturns = Object.entries(byMonth)
    .map(([month, data]) => ({ month, trades: data.trades, avgPnl: +(data.totalPnl / data.trades).toFixed(1), totalPnl: +data.totalPnl.toFixed(1) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    asOf,
    totalTrades: allStudies.length,
    activeTrades: active.length,
    closedTrades: closed.length,
    winRate: closed.length > 0 ? +(winners.length / closed.length * 100).toFixed(1) : 0,
    avgWinPct: winners.length > 0 ? +(grossWins / winners.length).toFixed(1) : 0,
    avgLossPct: losers.length > 0 ? +(-grossLosses / losers.length).toFixed(1) : 0,
    avgHoldingWeeks: closed.length > 0 ? +(closed.reduce((sum, t) => sum + (t.holdingWeeks || 0), 0) / closed.length).toFixed(1) : 0,
    profitFactor: grossLosses > 0 ? +(grossWins / grossLosses).toFixed(2) : (grossWins > 0 ? 999 : 0),
    bigWinnerRate: closed.length > 0 ? +(bigWinners.length / closed.length * 100).toFixed(1) : 0,
    byTier, byDirection, bySector, monthlyReturns,
    updatedAt: new Date(),
  };
}

// ── Case studies rebuild (top-10, $10k notional) ────────────────────────────────
function buildCaseStudies({ fridays, scoredByFriday, getClosePrice }) {
  const activeStudies = [];
  const closedStudies = [];
  const cooldownMap   = {};
  let totalEntries = 0, totalExits = 0;

  for (const friday of fridays) {
    const { scored, scoredMap } = scoredByFriday[friday];

    // Update + exit-check active studies with this Friday's mark
    for (let i = activeStudies.length - 1; i >= 0; i--) {
      const study = activeStudies[i];
      const sc = scoredMap[study.ticker];
      const currentPrice = sc?.currentPrice ?? getClosePrice(study.ticker, friday) ?? study.entryPrice;
      const isShort = study.direction === 'SHORT';
      const pnlPct = isShort
        ? ((study.entryPrice - currentPrice) / study.entryPrice) * 100
        : ((currentPrice - study.entryPrice) / study.entryPrice) * 100;

      const sigType = sc?.signal;
      const exitTriggered = (isShort && (!sigType || sigType === 'BL')) ||
                            (!isShort && (!sigType || sigType === 'SS'));

      study.weeklySnapshots.push({ date: friday, price: currentPrice, pnlPct: +pnlPct.toFixed(2), killRank: sc?.killRank ?? null, killScore: sc?.total ?? null });
      study.holdingWeeks = study.weeklySnapshots.length;
      study.maxFavorable = +(Math.max(study.maxFavorable, pnlPct > 0 ? pnlPct : 0)).toFixed(2);
      study.maxAdverse   = +(Math.min(study.maxAdverse,   pnlPct < 0 ? pnlPct : 0)).toFixed(2);

      if (exitTriggered) {
        study.status     = 'CLOSED';
        study.exitDate   = friday;
        study.exitPrice  = currentPrice;
        study.exitReason = isShort ? 'BE' : 'SE';
        study.pnlPct     = +pnlPct.toFixed(2);
        study.pnlDollar  = +((pnlPct / 100) * 10000).toFixed(2);
        closedStudies.push(study);
        activeStudies.splice(i, 1);
        totalExits++;
        const cd = new Date(friday + 'T12:00:00Z'); cd.setDate(cd.getDate() + CS_COOLDOWN_WEEKS * 7);
        cooldownMap[study.ticker] = cd.toISOString().split('T')[0];
      }
    }

    // New top-10 entries
    const top10 = scored.filter(s => s.killRank <= TOP_N).slice(0, TOP_N);
    for (const stock of top10) {
      if (activeStudies.some(s => s.ticker === stock.ticker)) continue;
      if (cooldownMap[stock.ticker] && friday < cooldownMap[stock.ticker]) continue;
      activeStudies.push({
        id: `ai300-${stock.ticker}-${friday}`,
        ticker: stock.ticker, direction: stock.direction, signal: stock.signal,
        sector: stock.sectorName || '—',
        entryDate: friday, entryPrice: stock.currentPrice,
        entryRank: stock.killRank, entryScore: stock.total, entryTier: stock.tierName, entryD3: stock.scores.d3,
        entrySource: 'BACKFILL', stopPrice: stock.stopPrice,
        status: 'ACTIVE', exitDate: null, exitPrice: null, exitReason: null,
        pnlPct: null, pnlDollar: null, holdingWeeks: 0, maxFavorable: 0, maxAdverse: 0,
        weeklySnapshots: [], createdAt: new Date(),
      });
      totalEntries++;
    }
  }

  return { allStudies: [...closedStudies, ...activeStudies], totalEntries, totalExits };
}

// ── Appearances rebuild (score≥80, 5-lot pyramid) ───────────────────────────────
function buildAppearances({ fridays, scoredByFriday, getWeeklyBar }) {
  const activeAppearances = [];
  const allAppearances    = [];
  const cooldownMap       = {};
  let totalCreated = 0, totalExited = 0, totalLotFills = 0;

  for (const friday of fridays) {
    const { scored, scoredMap } = scoredByFriday[friday];

    for (let i = activeAppearances.length - 1; i >= 0; i--) {
      const appr = activeAppearances[i];
      const bar  = getWeeklyBar(appr.ticker, friday);
      if (!bar) continue;
      const isShort = appr.signal === 'SS';
      const ohlc = { open: bar.open, high: bar.high, low: bar.low, close: bar.close };

      if (appr.lotConfig) {
        for (let li = 1; li < 5; li++) {
          const key = `lot${li + 1}`;
          const lot = appr.lotConfig.lots[li];
          const fill = appr.lotFills[key];
          if (!fill || fill.filled) continue;
          if (!appr.lotFills[`lot${li}`]?.filled) continue;
          if (li === 1) {
            const lot1Date = new Date(appr.lotFills.lot1.fillDate + 'T12:00:00');
            const todayD   = new Date(friday + 'T12:00:00');
            const daysDiff = Math.round((todayD - lot1Date) / (1000 * 60 * 60 * 24));
            if (Math.floor(daysDiff * 5 / 7) < 5) continue;
          }
          const trigger = lot.triggerPrice;
          const hit = isShort ? ohlc.low <= trigger : ohlc.high >= trigger;
          if (hit) { appr.lotFills[key] = { filled: true, fillDate: friday, fillPrice: trigger, shares: lot.targetShares }; totalLotFills++; }
        }
      }

      const currentStop = computeRatchetedStop(appr.lotFills, appr.firstStopPrice, appr.signal);
      appr.currentStop = currentStop;
      const stopHit = isShort ? ohlc.high >= currentStop : ohlc.low <= currentStop;

      let totalShares = 0, totalCost = 0, lotsFilledCount = 0;
      for (let n = 1; n <= 5; n++) {
        const f = appr.lotFills[`lot${n}`];
        const lot = appr.lotConfig?.lots?.[n - 1];
        if (f?.filled && lot) {
          const sh = f.shares || lot.targetShares;
          totalShares += sh; totalCost += sh * (f.fillPrice ?? lot.triggerPrice); lotsFilledCount++;
        }
      }
      const avgCost = totalShares > 0 ? +(totalCost / totalShares).toFixed(4) : 0;
      const closePrice = stopHit ? currentStop : ohlc.close;
      let pnlPct = 0, pnlDollar = 0;
      if (avgCost > 0 && totalShares > 0) {
        pnlPct = isShort ? ((avgCost - closePrice) / avgCost) * 100 : ((closePrice - avgCost) / avgCost) * 100;
        pnlDollar = isShort ? (avgCost - closePrice) * totalShares : (closePrice - avgCost) * totalShares;
      }

      appr.dailySnapshots.push({
        date: friday, open: ohlc.open, high: ohlc.high, low: ohlc.low, close: ohlc.close,
        currentStop, lotsFilledCount, totalShares, avgCost,
        pnlPct: +pnlPct.toFixed(2), pnlDollar: +pnlDollar.toFixed(2), stopHit, newLotsFilledToday: 0,
      });
      appr.currentAvgCost = avgCost; appr.currentShares = totalShares; appr.lotsFilledCount = lotsFilledCount;
      appr.lastSeenPrice = ohlc.close; appr.lastSeenDate = friday;
      appr.currentPnlPct = +pnlPct.toFixed(2); appr.currentPnlDollar = +pnlDollar.toFixed(2);
      appr.updatedAt = new Date();

      const sc = scoredMap[appr.ticker];
      const signalGone = !sc || sc.signal !== appr.signal;
      if (stopHit || signalGone) {
        appr.exitDate = friday;
        appr.exitPrice = stopHit ? currentStop : closePrice;
        appr.exitReason = stopHit ? 'STOP' : (isShort ? 'BE' : 'SE');
        appr.profitPct = +pnlPct.toFixed(4); appr.profitDollar = +pnlDollar.toFixed(2);
        appr.isWinner = pnlPct > 0;
        appr.holdingWeeks = Math.round((new Date(friday) - new Date(appr.firstAppearanceDate + 'T12:00:00')) / (7 * 24 * 60 * 60 * 1000));
        allAppearances.push(appr);
        activeAppearances.splice(i, 1);
        totalExited++;
        const cd = new Date(friday + 'T12:00:00Z'); cd.setDate(cd.getDate() + AP_COOLDOWN_WEEKS * 7);
        cooldownMap[`${appr.ticker}|${appr.signal}`] = cd.toISOString().split('T')[0];
      }
    }

    const qualifying = scored.filter(s => s.total >= KILL_THRESHOLD);
    for (const stock of qualifying) {
      if (activeAppearances.some(a => a.ticker === stock.ticker && a.signal === stock.signal)) continue;
      const ck = `${stock.ticker}|${stock.signal}`;
      if (cooldownMap[ck] && friday < cooldownMap[ck]) continue;
      const entryPrice = stock.currentPrice, stopPrice = stock.stopPrice;
      if (!entryPrice || !stopPrice) continue;
      const riskPct = Math.abs((entryPrice - stopPrice) / entryPrice * 100);
      const sized = serverSizePosition({ nav: NAV, entryPrice, stopPrice, riskPct: RISK_PCT });
      if (!sized || sized.totalShares <= 0) continue;
      const lots = buildServerLotConfig(sized.totalShares, entryPrice, stock.signal);
      const lot1Shares = lots[0].targetShares;
      activeAppearances.push({
        ticker: stock.ticker, signal: stock.signal, sector: stock.sectorName || '—', exchange: null,
        firstAppearanceDate: friday, firstAppearancePrice: entryPrice, firstStopPrice: stopPrice,
        firstRiskPct: +riskPct.toFixed(2), firstKillScore: stock.total, firstKillRank: stock.killRank, firstTier: stock.tierName,
        lotConfig: { nav: NAV, riskPct: RISK_PCT, totalShares: sized.totalShares, maxRiskDollar: sized.maxRiskDollar, lots },
        lotFills: {
          lot1: { filled: true,  fillDate: friday, fillPrice: entryPrice, shares: lot1Shares },
          lot2: { filled: false, fillDate: null, fillPrice: null, shares: null },
          lot3: { filled: false, fillDate: null, fillPrice: null, shares: null },
          lot4: { filled: false, fillDate: null, fillPrice: null, shares: null },
          lot5: { filled: false, fillDate: null, fillPrice: null, shares: null },
        },
        currentStop: stopPrice, currentAvgCost: entryPrice, currentShares: lot1Shares, lotsFilledCount: 1,
        lastSeenDate: friday, lastSeenPrice: entryPrice, lastKillScore: stock.total, lastKillRank: stock.killRank,
        currentPnlPct: 0, currentPnlDollar: 0,
        exitDate: null, exitPrice: null, exitReason: null, profitPct: null, profitDollar: null, isWinner: null, holdingWeeks: null,
        dailySnapshots: [], createdAt: new Date(), updatedAt: new Date(),
      });
      totalCreated++;
    }
  }

  for (const appr of activeAppearances) allAppearances.push(appr);
  return { allAppearances, totalCreated, totalExited, totalLotFills };
}

// ── Public API ──────────────────────────────────────────────────────────────────
/**
 * Rebuild the AI 300 Kill 10 track record(s) deterministically from candle data.
 * @param {object} opts
 * @param {boolean} opts.dryRun  — compute + summarize but write nothing
 * @param {'both'|'case_studies'|'appearances'} opts.part
 * @param {boolean} opts.regenMonthly — regenerate the appearances monthly equity + risk
 *        metrics (powers Equity & Breakdown / Portfolio Analytics). Default true.
 * @param {boolean} opts.fullMonthly — drop + fully rebuild ALL monthly snapshots
 *        (needed after a data change that alters history). Default false = incremental
 *        (current month only), which is correct for the daily cron.
 * @param {import('mongodb').Db} [opts.db] — optional; defaults to connectToDatabase()
 */
export async function rebuildAi300Kill({ dryRun = false, part = 'both', regenMonthly = true, fullMonthly = false, db: passedDb } = {}) {
  const db = passedDb || await connectToDatabase();
  if (!db) throw new Error('No DB connection');
  const asOf = new Date().toISOString().split('T')[0];

  const t0 = Date.now();
  const inputs = await loadInputs(db);
  const out = { dryRun, part, asOf, fridays: inputs.fridays.length, span: `${inputs.fridays[0]} → ${inputs.fridays[inputs.fridays.length - 1]}` };

  if (part === 'both' || part === 'case_studies') {
    const { allStudies, totalEntries, totalExits } = buildCaseStudies(inputs);
    const record = buildTrackRecord(allStudies, asOf);
    const active = allStudies.filter(s => s.status === 'ACTIVE');
    const latestEntry = allStudies.reduce((m, s) => s.entryDate > m ? s.entryDate : m, '');
    const newestActive = [...active].sort((a, b) => b.entryDate.localeCompare(a.entryDate)).slice(0, 12)
      .map(s => ({ ticker: s.ticker, dir: s.direction, entry: s.entryDate, rank: s.entryRank, tier: s.entryTier, weeks: s.holdingWeeks }));

    out.caseStudies = {
      total: allStudies.length, active: active.length, closed: allStudies.length - active.length,
      totalEntries, totalExits, latestEntry,
      winRate: record.winRate, profitFactor: record.profitFactor, avgWinPct: record.avgWinPct, avgLossPct: record.avgLossPct,
      lastMonths: record.monthlyReturns.slice(-4), newestActive,
    };

    if (!dryRun) {
      if (allStudies.length === 0) throw new Error('Case-study rebuild produced 0 rows — aborting write (candle data missing?)');
      out.caseStudies.backup = await backupCollection(db, CASE_STUDIES);
      out.caseStudies.trackRecordBackup = await backupCollection(db, TRACK_RECORD);
      await db.collection(CASE_STUDIES).deleteMany({});
      await db.collection(CASE_STUDIES).insertMany(allStudies);
      await db.collection(CASE_STUDIES).createIndex({ ticker: 1, status: 1 });
      await db.collection(CASE_STUDIES).createIndex({ status: 1, entryDate: -1 });
      await db.collection(CASE_STUDIES).createIndex({ id: 1 }, { unique: true });
      await db.collection(TRACK_RECORD).deleteMany({});
      await db.collection(TRACK_RECORD).insertOne(record);
      await db.collection(TRACK_RECORD).createIndex({ asOf: -1 });
    }
  }

  if (part === 'both' || part === 'appearances') {
    const { allAppearances, totalCreated, totalExited, totalLotFills } = buildAppearances(inputs);
    const active = allAppearances.filter(a => !a.exitDate);
    const closed = allAppearances.filter(a => a.exitDate);
    const winners = closed.filter(a => (a.profitPct ?? 0) > 0);
    const latestEntry = allAppearances.reduce((m, a) => a.firstAppearanceDate > m ? a.firstAppearanceDate : m, '');
    const newestActive = [...active].sort((a, b) => b.firstAppearanceDate.localeCompare(a.firstAppearanceDate)).slice(0, 12)
      .map(a => ({ ticker: a.ticker, sig: a.signal, entry: a.firstAppearanceDate, rank: a.firstKillRank, lots: a.lotsFilledCount, pnlPct: a.currentPnlPct }));

    out.appearances = {
      total: allAppearances.length, active: active.length, closed: closed.length,
      totalCreated, totalExited, totalLotFills, latestEntry,
      winRate: closed.length ? +(winners.length / closed.length * 100).toFixed(1) : 0,
      newestActive,
    };

    if (!dryRun) {
      if (allAppearances.length === 0) throw new Error('Appearances rebuild produced 0 rows — aborting write (candle data missing?)');
      out.appearances.backup = await backupCollection(db, APPEARANCES);
      await db.collection(APPEARANCES).deleteMany({});
      await db.collection(APPEARANCES).insertMany(allAppearances);
      await db.collection(APPEARANCES).createIndex({ ticker: 1, signal: 1, exitDate: 1 });
      await db.collection(APPEARANCES).createIndex({ firstAppearanceDate: -1 });
      await db.collection(APPEARANCES).createIndex({ exitDate: 1 });

      // Regenerate the monthly equity snapshots + risk metrics that drive the
      // Equity & Breakdown / Portfolio Analytics tabs (computed from appearances).
      if (regenMonthly) {
        try {
          const { generateAi300MonthlySnapshots } = await import('./ai300KillTestMonthly.js');
          if (fullMonthly) {
            // History changed → drop stale snapshots (all scenarios) and rebuild from scratch.
            out.appearances.monthlyBackup = await backupCollection(db, 'pnthr_ai300_kill_test_monthly');
            out.appearances.metricsBackup = await backupCollection(db, 'pnthr_ai300_kill_test_metrics');
            await db.collection('pnthr_ai300_kill_test_monthly').deleteMany({});
            await db.collection('pnthr_ai300_kill_test_metrics').deleteMany({});
          }
          const months = await generateAi300MonthlySnapshots(db, null, null, 'all');
          out.appearances.monthlyRegenerated = months ? months.length : 0;
        } catch (e) {
          out.appearances.monthlyError = e.message;
          console.error('[AI300 Kill Rebuild] monthly regen failed:', e.message);
        }
      }
    }
  }

  out.elapsedMs = Date.now() - t0;
  console.log(`[AI300 Kill Rebuild] ${dryRun ? 'DRY-RUN' : 'WROTE'} part=${part} in ${out.elapsedMs}ms`,
    out.caseStudies ? `| CS active=${out.caseStudies.active} closed=${out.caseStudies.closed} latest=${out.caseStudies.latestEntry}` : '',
    out.appearances ? `| AP active=${out.appearances.active} closed=${out.appearances.closed} latest=${out.appearances.latestEntry}` : '');
  return out;
}
