// server/scripts/backfillAi300KillTestAppearances.js
// ── Backfill: AI 300 Kill Test appearances with full pyramid simulation ───────
//
// Walks every Friday from inception, re-runs AI Kill scoring, and for every
// qualifying ticker (score ≥ 80 = HUNTING+), creates a Kill Test appearance
// with full 5-lot pyramid sizing, lot fill triggers, stop ratcheting, and
// exit detection. Uses weekly OHLC bars to simulate intra-week price action.
//
// Run: node --env-file=server/.env server/scripts/backfillAi300KillTestAppearances.js

import { MongoClient } from 'mongodb';

// ── Config ────────────────────────────────────────────────────────────────────
const START_DATE       = '2022-12-02';  // first Friday after inception (Nov 30 2022)
const KILL_THRESHOLD   = 80;            // HUNTING+ (matches AI300_KT_DEFAULTS.killThreshold)
const NAV              = 100000;
const RISK_PCT         = 1;
const COOLDOWN_WEEKS   = 8;             // 8-week cooldown after exit before re-entry

// Lot sizing constants (mirrors killTestSettings.js)
const STRIKE_PCT  = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_OFFSETS = [0,    0.03, 0.06, 0.10, 0.14];

// ── Inline AI Kill scoring (same as backfillAi300KillHistory.js) ──────────────

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

// ── Signal detection (inline) ─────────────────────────────────────────────────

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

const AI_GATE_OFFSET = 0.25;

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

// ── Lot sizing helpers (mirrors killTestSettings.js) ──────────────────────────

function serverSizePosition({ nav, entryPrice, stopPrice, riskPct = 1 }) {
  if (!entryPrice || !stopPrice || !nav || nav <= 0) return null;
  const tickerCap = nav * 0.10;
  const vitality  = nav * (riskPct / 100);
  const rps       = Math.abs(entryPrice - stopPrice);
  if (rps <= 0) return null;
  const totalShares = Math.floor(
    Math.min(Math.floor(vitality / rps), Math.floor(tickerCap / entryPrice))
  );
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

// ── Main backfill ─────────────────────────────────────────────────────────────

async function backfill() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('pnthr_den');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  PNTHR AI 300 Kill Test — Appearances Backfill (Full Pyramid)');
  console.log('═══════════════════════════════════════════════════════════════');

  // ── 1. Load config ────────────────────────────────────────────────────────
  const { SECTORS } = await import('../scripts/aiUniverse/aiUniverseData.js');
  const { SECTOR_EMA_PERIODS } = await import('../data/pnthrAiSectorsConfig.js');

  const TICKER_META = {};
  for (const sec of SECTORS) {
    for (const h of sec.holdings) {
      TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name };
    }
  }
  const tickers = Object.keys(TICKER_META);
  console.log(`Loaded ${tickers.length} AI Universe tickers`);

  // ── 2. Load weekly bar data ───────────────────────────────────────────────
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, weekly: 1 } })
    .toArray();
  const weeklyByTicker = {};
  for (const d of weeklyDocs) {
    weeklyByTicker[d.ticker] = [...(d.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }
  console.log(`Loaded weekly bars for ${weeklyDocs.length} tickers`);

  // ── 3. PAI300 weekly bars (for D1 regime) ─────────────────────────────────
  const paiDoc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
  const paiWeekly = (paiDoc?.weekly || []).slice().sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  console.log(`PAI300 weekly bars: ${paiWeekly.length}`);

  // ── 4. Sector rotation ranks ──────────────────────────────────────────────
  const sectorRankDocs = await db.collection('pnthr_ai_sector_rank_daily')
    .find({}).sort({ date: 1 }).toArray();
  const sectorRankByDate = {};
  for (const doc of sectorRankDocs) {
    const byId = {};
    for (const r of (doc.ranks || [])) byId[r.sectorId] = r.tier;
    sectorRankByDate[doc.date] = byId;
  }
  const sectorRankDates = Object.keys(sectorRankByDate).sort();
  console.log(`Sector rank docs: ${sectorRankDates.length}`);

  function getSectorTierOn(sectorId, date) {
    for (let i = sectorRankDates.length - 1; i >= 0; i--) {
      if (sectorRankDates[i] <= date) return sectorRankByDate[sectorRankDates[i]]?.[sectorId] ?? null;
    }
    return null;
  }

  // ── 5. Build Friday list ──────────────────────────────────────────────────
  const fridays = [];
  const today = new Date().toISOString().split('T')[0];
  let d = new Date(START_DATE + 'T12:00:00Z');
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  while (d.toISOString().split('T')[0] <= today) {
    fridays.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 7);
  }
  console.log(`Processing ${fridays.length} Fridays: ${fridays[0]} → ${fridays[fridays.length-1]}`);

  // ── 6. PAI300 regime helper ───────────────────────────────────────────────
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

  // Close price lookup helper
  function getClosePrice(ticker, date) {
    const wk = weeklyByTicker[ticker];
    if (!wk || wk.length === 0) return null;
    for (let i = wk.length - 1; i >= 0; i--) {
      if (wk[i].weekOf <= date) return wk[i].close;
    }
    return null;
  }

  // Weekly OHLC lookup
  function getWeeklyBar(ticker, date) {
    const wk = weeklyByTicker[ticker];
    if (!wk) return null;
    for (let i = wk.length - 1; i >= 0; i--) {
      if (wk[i].weekOf <= date) return wk[i];
    }
    return null;
  }

  // ── 7. Drop and rebuild ───────────────────────────────────────────────────
  await db.collection('pnthr_ai300_kill_appearances').drop().catch(() => {});
  console.log('Dropped existing pnthr_ai300_kill_appearances\n');

  // In-memory tracking
  const activeAppearances = [];  // live appearances being tracked
  const allAppearances    = [];  // completed + still active at end
  const cooldownMap       = {};  // ticker|signal → earliest re-entry date

  let totalCreated = 0, totalExited = 0, totalLotFills = 0;

  for (let fi = 0; fi < fridays.length; fi++) {
    const friday = fridays[fi];
    const pai300Bull = pai300BullAt(friday);

    // ── Score all tickers for this Friday ────────────────────────────────
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
        if (events[i].signal === activeType) {
          signalDate = events[i].time;
          isNewSignal = events[i].time === lastBar.weekOf;
          break;
        }
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

    // ── Update active appearances: lot fills, stops, exits ──────────────
    for (let i = activeAppearances.length - 1; i >= 0; i--) {
      const appr = activeAppearances[i];
      const bar  = getWeeklyBar(appr.ticker, friday);
      if (!bar) continue;

      const isShort = appr.signal === 'SS';
      const ohlc = { open: bar.open, high: bar.high, low: bar.low, close: bar.close };

      // Lot fill triggers (using weekly OHLC)
      if (appr.lotConfig) {
        for (let li = 1; li < 5; li++) {
          const key  = `lot${li + 1}`;
          const lot  = appr.lotConfig.lots[li];
          const fill = appr.lotFills[key];
          if (!fill || fill.filled) continue;
          const priorKey = `lot${li}`;
          if (!appr.lotFills[priorKey]?.filled) continue;

          // Lot 2 time gate: 5 trading days (~1 week) after lot 1
          if (li === 1) {
            const lot1Date = new Date(appr.lotFills.lot1.fillDate + 'T12:00:00');
            const todayD   = new Date(friday + 'T12:00:00');
            const daysDiff = Math.round((todayD - lot1Date) / (1000 * 60 * 60 * 24));
            const tradingDays = Math.floor(daysDiff * 5 / 7);
            if (tradingDays < 5) continue;
          }

          const trigger = lot.triggerPrice;
          const hit = isShort ? ohlc.low <= trigger : ohlc.high >= trigger;
          if (hit) {
            appr.lotFills[key] = { filled: true, fillDate: friday, fillPrice: trigger, shares: lot.targetShares };
            totalLotFills++;
          }
        }
      }

      // Ratchet stop
      const currentStop = computeRatchetedStop(appr.lotFills, appr.firstStopPrice, appr.signal);
      appr.currentStop = currentStop;

      // Check stop hit
      const stopHit = isShort ? ohlc.high >= currentStop : ohlc.low <= currentStop;

      // Compute position metrics
      let totalShares = 0, totalCost = 0, lotsFilledCount = 0;
      for (let n = 1; n <= 5; n++) {
        const f   = appr.lotFills[`lot${n}`];
        const lot = appr.lotConfig?.lots?.[n - 1];
        if (f?.filled && lot) {
          const sh = f.shares || lot.targetShares;
          totalShares += sh;
          totalCost   += sh * (f.fillPrice ?? lot.triggerPrice);
          lotsFilledCount++;
        }
      }
      const avgCost = totalShares > 0 ? +(totalCost / totalShares).toFixed(4) : 0;
      const closePrice = stopHit ? currentStop : ohlc.close;
      let pnlPct = 0, pnlDollar = 0;
      if (avgCost > 0 && totalShares > 0) {
        pnlPct = isShort
          ? ((avgCost - closePrice) / avgCost) * 100
          : ((closePrice - avgCost) / avgCost) * 100;
        pnlDollar = isShort
          ? (avgCost - closePrice) * totalShares
          : (closePrice - avgCost) * totalShares;
      }

      // Weekly snapshot (stored as dailySnapshots for compatibility)
      appr.dailySnapshots.push({
        date: friday, open: ohlc.open, high: ohlc.high, low: ohlc.low, close: ohlc.close,
        currentStop, lotsFilledCount, totalShares, avgCost,
        pnlPct: +pnlPct.toFixed(2), pnlDollar: +pnlDollar.toFixed(2),
        stopHit, newLotsFilledToday: 0,
      });

      // Update live fields
      appr.currentAvgCost    = avgCost;
      appr.currentShares     = totalShares;
      appr.lotsFilledCount   = lotsFilledCount;
      appr.lastSeenPrice     = ohlc.close;
      appr.lastSeenDate      = friday;
      appr.currentPnlPct     = +pnlPct.toFixed(2);
      appr.currentPnlDollar  = +pnlDollar.toFixed(2);
      appr.updatedAt         = new Date();

      // Check for signal exit (signal no longer active)
      const sc = scoredMap[appr.ticker];
      const signalGone = !sc || sc.signal !== appr.signal;

      if (stopHit || signalGone) {
        appr.exitDate     = friday;
        appr.exitPrice    = stopHit ? currentStop : closePrice;
        appr.exitReason   = stopHit ? 'STOP' : (isShort ? 'BE' : 'SE');
        appr.profitPct    = +pnlPct.toFixed(4);
        appr.profitDollar = +pnlDollar.toFixed(2);
        appr.isWinner     = pnlPct > 0;
        appr.holdingWeeks = Math.round((new Date(friday) - new Date(appr.firstAppearanceDate + 'T12:00:00')) / (7 * 24 * 60 * 60 * 1000));

        allAppearances.push(appr);
        activeAppearances.splice(i, 1);
        totalExited++;

        const cooldownEnd = new Date(friday + 'T12:00:00Z');
        cooldownEnd.setDate(cooldownEnd.getDate() + COOLDOWN_WEEKS * 7);
        cooldownMap[`${appr.ticker}|${appr.signal}`] = cooldownEnd.toISOString().split('T')[0];
      }
    }

    // ── Create new appearances for qualifying tickers ────────────────────
    const qualifying = scored.filter(s => s.total >= KILL_THRESHOLD);

    for (const stock of qualifying) {
      // Skip if already tracking
      if (activeAppearances.some(a => a.ticker === stock.ticker && a.signal === stock.signal)) continue;
      // Cooldown check
      const ck = `${stock.ticker}|${stock.signal}`;
      if (cooldownMap[ck] && friday < cooldownMap[ck]) continue;

      const entryPrice = stock.currentPrice;
      const stopPrice  = stock.stopPrice;
      if (!entryPrice || !stopPrice) continue;

      const riskPct = Math.abs((entryPrice - stopPrice) / entryPrice * 100);
      const sized = serverSizePosition({ nav: NAV, entryPrice, stopPrice, riskPct: RISK_PCT });
      if (!sized || sized.totalShares <= 0) continue;

      const lots = buildServerLotConfig(sized.totalShares, entryPrice, stock.signal);
      const lotConfig = {
        nav: NAV, riskPct: RISK_PCT,
        totalShares: sized.totalShares,
        maxRiskDollar: sized.maxRiskDollar,
        lots,
      };

      const lot1Shares = lots[0].targetShares;

      const appr = {
        ticker:               stock.ticker,
        signal:               stock.signal,
        sector:               stock.sectorName || '—',
        exchange:             null,
        firstAppearanceDate:  friday,
        firstAppearancePrice: entryPrice,
        firstStopPrice:       stopPrice,
        firstRiskPct:         +riskPct.toFixed(2),
        firstKillScore:       stock.total,
        firstKillRank:        stock.killRank,
        firstTier:            stock.tierName,
        lotConfig,
        lotFills: {
          lot1: { filled: true,  fillDate: friday, fillPrice: entryPrice, shares: lot1Shares },
          lot2: { filled: false, fillDate: null, fillPrice: null, shares: null },
          lot3: { filled: false, fillDate: null, fillPrice: null, shares: null },
          lot4: { filled: false, fillDate: null, fillPrice: null, shares: null },
          lot5: { filled: false, fillDate: null, fillPrice: null, shares: null },
        },
        currentStop:       stopPrice,
        currentAvgCost:    entryPrice,
        currentShares:     lot1Shares,
        lotsFilledCount:   1,
        lastSeenDate:      friday,
        lastSeenPrice:     entryPrice,
        lastKillScore:     stock.total,
        lastKillRank:      stock.killRank,
        currentPnlPct:     0,
        currentPnlDollar:  0,
        exitDate:          null,
        exitPrice:         null,
        exitReason:        null,
        profitPct:         null,
        profitDollar:      null,
        isWinner:          null,
        holdingWeeks:      null,
        dailySnapshots:    [],
        createdAt:         new Date(),
        updatedAt:         new Date(),
      };

      activeAppearances.push(appr);
      totalCreated++;
    }

    // Progress
    if (fi % 10 === 0) {
      const bullStr = pai300Bull == null ? 'N/A' : (pai300Bull ? 'BULL' : 'BEAR');
      process.stdout.write(`  ${friday} | scored=${scored.length} qual=${qualifying.length} active=${activeAppearances.length} closed=${allAppearances.length} regime=${bullStr}\r`);
    }
  }

  // Still-active appearances go into allAppearances too
  for (const appr of activeAppearances) allAppearances.push(appr);

  console.log('\n');
  console.log(`Total appearances: ${allAppearances.length} (${allAppearances.filter(a => a.exitDate).length} closed, ${allAppearances.filter(a => !a.exitDate).length} active)`);
  console.log(`Created: ${totalCreated}, Exited: ${totalExited}, Lot fills: ${totalLotFills}`);

  // ── 8. Write to MongoDB ───────────────────────────────────────────────────
  if (allAppearances.length > 0) {
    await db.collection('pnthr_ai300_kill_appearances').insertMany(allAppearances);
    console.log(`Inserted ${allAppearances.length} appearance documents`);
  }

  await db.collection('pnthr_ai300_kill_appearances').createIndex({ ticker: 1, signal: 1, exitDate: 1 });
  await db.collection('pnthr_ai300_kill_appearances').createIndex({ firstAppearanceDate: -1 });
  await db.collection('pnthr_ai300_kill_appearances').createIndex({ exitDate: 1 });

  // ── 9. Summary stats ──────────────────────────────────────────────────────
  const closed  = allAppearances.filter(a => a.exitDate);
  const active  = allAppearances.filter(a => !a.exitDate);
  const winners = closed.filter(a => (a.profitPct ?? 0) > 0);
  const losers  = closed.filter(a => (a.profitPct ?? 0) <= 0);
  const grossW  = winners.reduce((s, a) => s + (a.profitPct ?? 0), 0);
  const grossL  = Math.abs(losers.reduce((s, a) => s + (a.profitPct ?? 0), 0));
  const winRate = closed.length > 0 ? +(winners.length / closed.length * 100).toFixed(1) : 0;
  const pf      = grossL > 0 ? +(grossW / grossL).toFixed(2) : (grossW > 0 ? 999 : 0);
  const avgWin  = winners.length > 0 ? +(grossW / winners.length).toFixed(1) : 0;
  const avgLoss = losers.length > 0 ? +(-grossL / losers.length).toFixed(1) : 0;
  const avgHold = closed.length > 0 ? +(closed.reduce((s, a) => s + (a.holdingWeeks || 0), 0) / closed.length).toFixed(1) : 0;

  // Lot fill distribution
  const lotDist = [0, 0, 0, 0, 0];
  for (const a of closed) {
    let filled = 0;
    for (let n = 1; n <= 5; n++) if (a.lotFills?.[`lot${n}`]?.filled) filled++;
    lotDist[filled - 1]++;
  }

  // By exit reason
  const byReason = {};
  for (const a of closed) {
    const r = a.exitReason || 'UNKNOWN';
    if (!byReason[r]) byReason[r] = { count: 0, wins: 0, totalPnl: 0 };
    byReason[r].count++;
    if ((a.profitPct ?? 0) > 0) byReason[r].wins++;
    byReason[r].totalPnl += (a.profitPct ?? 0);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total:          ${allAppearances.length}`);
  console.log(`  Active:         ${active.length}`);
  console.log(`  Closed:         ${closed.length}`);
  console.log(`  Win Rate:       ${winRate}%`);
  console.log(`  Avg Win:        +${avgWin}%`);
  console.log(`  Avg Loss:       ${avgLoss}%`);
  console.log(`  Profit Factor:  ${pf}x`);
  console.log(`  Avg Holding:    ${avgHold} weeks`);
  console.log(`  Total Lot Fills: ${totalLotFills}`);
  console.log('');
  console.log('  Lot Distribution (closed):');
  for (let i = 0; i < 5; i++) console.log(`    ${i + 1} lot${i > 0 ? 's' : ''} filled: ${lotDist[i]}`);
  console.log('');
  console.log('  By Exit Reason:');
  for (const [reason, data] of Object.entries(byReason)) {
    const wr = +(data.wins / data.count * 100).toFixed(1);
    const avg = +(data.totalPnl / data.count).toFixed(1);
    console.log(`    ${reason.padEnd(8)} ${data.count} trades | WR: ${wr}% | Avg: ${avg > 0 ? '+' : ''}${avg}%`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  AI 300 Kill Test appearances backfill complete ✓');
  console.log('═══════════════════════════════════════════════════════════════');

  await client.close();
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
