// server/scripts/backfillAi300KillHistory.js
// ── Backfill: AI 300 Kill 10 case studies from historical re-scoring ──────────
//
// Walks every Friday from startDate through today, re-runs the AI Kill D1–D4
// formula using stored candle data, takes the top 10, and creates/updates/closes
// case studies exactly as the live pipeline does.
//
// Run: node --env-file=server/.env server/scripts/backfillAi300KillHistory.js

import { MongoClient } from 'mongodb';

// ── Config ────────────────────────────────────────────────────────────────────
const START_DATE = '2022-12-02';    // first Friday after AI Universe inception (2022-11-30); EMA warmup from Jan 2022 bars is already complete
const TOP_N      = 10;              // top N ranked stocks enter as case studies
const COOLDOWN_WEEKS = 2;           // weeks after close before re-entry

// ── Inline AI Kill scoring (mirrors aiKillService.js) ─────────────────────────

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

// ── Signal detection (inline from signalDetection.js) ─────────────────────────

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

// ── Main backfill ─────────────────────────────────────────────────────────────

async function backfill() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('pnthr_den');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  PNTHR AI 300 Kill 10 — Historical Backfill');
  console.log('═══════════════════════════════════════════════════════════════');

  // ── 1. Load AI Universe sectors config ────────────────────────────────────
  const { SECTORS } = await import('../scripts/aiUniverse/aiUniverseData.js');
  const { SECTOR_EMA_PERIODS } = await import('../data/pnthrAiSectorsConfig.js');

  const TICKER_META = {};
  for (const sec of SECTORS) {
    for (const h of sec.holdings) {
      TICKER_META[h.ticker] = { sectorId: sec.id, sectorName: sec.name };
    }
  }
  const tickers = Object.keys(TICKER_META);
  console.log(`Loaded ${tickers.length} AI Universe tickers across ${SECTORS.length} sectors`);

  // ── 2. Load all weekly bar data ───────────────────────────────────────────
  const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
    .find({ ticker: { $in: tickers } }, { projection: { ticker: 1, weekly: 1 } })
    .toArray();
  const weeklyByTicker = {};
  for (const d of weeklyDocs) {
    weeklyByTicker[d.ticker] = [...(d.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }
  console.log(`Loaded weekly bars for ${weeklyDocs.length} tickers`);

  // Helper: get the close price for a ticker on or before a given date
  function getClosePrice(ticker, date) {
    const wk = weeklyByTicker[ticker];
    if (!wk || wk.length === 0) return null;
    // Find the last bar on or before this date
    for (let i = wk.length - 1; i >= 0; i--) {
      if (wk[i].weekOf <= date) return wk[i].close;
    }
    return null;
  }

  // ── 3. Load PAI300 index weekly bars (for D1 regime) ──────────────────────
  const paiDoc = await db.collection('pnthr_ai_index_candles_weekly').findOne({ ticker: 'PAI300' });
  const paiWeekly = (paiDoc?.weekly || []).slice().sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const paiByDate = {};
  for (const b of paiWeekly) paiByDate[b.weekOf] = b.close;
  console.log(`PAI300 weekly bars: ${paiWeekly.length} (${paiWeekly[0]?.weekOf} → ${paiWeekly[paiWeekly.length-1]?.weekOf})`);

  // ── 4. Load sector rotation ranks (for D2 tier) ──────────────────────────
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
    let best = null;
    for (let i = sectorRankDates.length - 1; i >= 0; i--) {
      if (sectorRankDates[i] <= date) { best = sectorRankDates[i]; break; }
    }
    return best ? (sectorRankByDate[best]?.[sectorId] ?? null) : null;
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

  // ── 6. Compute PAI300 36W EMA at each Friday ─────────────────────────────
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

  // ── 7. Drop existing and rebuild ──────────────────────────────────────────
  await db.collection('pnthr_ai300_kill_case_studies').drop().catch(() => {});
  await db.collection('pnthr_ai300_kill_track_record').drop().catch(() => {});
  console.log('Dropped existing AI 300 Kill 10 collections\n');

  // Active case studies tracker (in-memory simulation)
  const activeStudies = [];   // { id, ticker, direction, sector, entryDate, entryPrice, entryRank, entryScore, entryTier, entryD3, stopPrice, weeklySnapshots[], maxFavorable, maxAdverse }
  const closedStudies = [];
  const cooldownMap   = {};   // ticker -> earliest re-entry date

  let totalEntries = 0, totalExits = 0;

  for (const friday of fridays) {
    const pai300Bull = pai300BullAt(friday);

    // Score every ticker for this Friday
    const scored = [];

    for (const ticker of tickers) {
      const meta   = TICKER_META[ticker];
      const period = SECTOR_EMA_PERIODS[meta.sectorId] || 30;
      const wk     = weeklyByTicker[ticker] || [];

      // Only use bars up to this Friday
      const barsUpTo = wk.filter(b => b.weekOf <= friday);
      if (barsUpTo.length < period + 2) continue;

      // Run signal detection on bars up to this Friday
      const wBars = barsUpTo.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close }));
      const { events, pnthrStop, activeType } = detectAllSignals(wBars, period, false, null, AI_GATE_OFFSET);

      if (!activeType || (activeType !== 'BL' && activeType !== 'SS')) continue;

      const direction = activeType === 'BL' ? 'LONG' : 'SHORT';
      const lastBar   = barsUpTo[barsUpTo.length - 1];
      const close     = lastBar.close;
      const stopPrice = pnthrStop;

      // Find the signal date (when this BL/SS was fired)
      let signalDate = null;
      let isNewSignal = false;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].signal === activeType) {
          signalDate = events[i].time;
          isNewSignal = events[i].time === lastBar.weekOf;
          break;
        }
      }

      // Compute EMA + slope for D3
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
      if (close != null && stopPrice != null) {
        const r = direction === 'LONG' ? (close - stopPrice) : (stopPrice - close);
        if (r > 0) riskPct = (r / close) * 100;
      }

      // D2: sector tier
      const sectorTier = getSectorTierOn(meta.sectorId, friday);

      const d1 = scoreD1(direction, pai300Bull);
      const d2 = scoreD2(direction, sectorTier);
      const d3 = scoreD3(direction, close, ema, emaSlopeAnn, riskPct);
      const d4 = scoreD4(signalDate, isNewSignal, friday);
      const subtotal = d2 + d3 + d4;
      const total = +(subtotal * d1).toFixed(2);

      scored.push({
        ticker,
        sectorName: meta.sectorName,
        sectorId:   meta.sectorId,
        signal:     activeType,
        direction,
        currentPrice: close,
        stopPrice,
        signalDate,
        isNewSignal,
        total,
        tierName: getTier(total),
        scores: { d1, d2: +d2.toFixed(1), d3: +d3.toFixed(1), d4 },
      });
    }

    // Rank
    scored.sort((a, b) => b.total - a.total || b.scores.d3 - a.scores.d3);
    scored.forEach((s, i) => { s.killRank = i + 1; });

    const scoredMap = {};
    for (const s of scored) scoredMap[s.ticker] = s;

    // ── Update active studies with this Friday's snapshot ────────────────
    for (let i = activeStudies.length - 1; i >= 0; i--) {
      const study = activeStudies[i];
      const sc = scoredMap[study.ticker];
      const currentPrice = sc?.currentPrice ?? getClosePrice(study.ticker, friday) ?? study.entryPrice;
      const isShort = study.direction === 'SHORT';
      const pnlPct = isShort
        ? ((study.entryPrice - currentPrice) / study.entryPrice) * 100
        : ((currentPrice - study.entryPrice) / study.entryPrice) * 100;

      // Check for BE/SE exit — signal no longer active or reversed
      const sigType = sc?.signal;
      const exitTriggered = (isShort && (!sigType || sigType === 'BL')) ||
                            (!isShort && (!sigType || sigType === 'SS'));

      const snapshot = {
        date:      friday,
        price:     currentPrice,
        pnlPct:    +pnlPct.toFixed(2),
        killRank:  sc?.killRank ?? null,
        killScore: sc?.total ?? null,
      };

      study.weeklySnapshots.push(snapshot);
      study.holdingWeeks = study.weeklySnapshots.length;
      study.maxFavorable = +(Math.max(study.maxFavorable, pnlPct > 0 ? pnlPct : 0)).toFixed(2);
      study.maxAdverse   = +(Math.min(study.maxAdverse,   pnlPct < 0 ? pnlPct : 0)).toFixed(2);

      if (exitTriggered) {
        const pnlDollar = (pnlPct / 100) * 10000;
        study.status     = 'CLOSED';
        study.exitDate   = friday;
        study.exitPrice  = currentPrice;
        study.exitReason = isShort ? 'BE' : 'SE';
        study.pnlPct     = +pnlPct.toFixed(2);
        study.pnlDollar  = +pnlDollar.toFixed(2);

        closedStudies.push(study);
        activeStudies.splice(i, 1);
        totalExits++;

        // Set cooldown
        const cooldownEnd = new Date(friday + 'T12:00:00Z');
        cooldownEnd.setDate(cooldownEnd.getDate() + COOLDOWN_WEEKS * 7);
        cooldownMap[study.ticker] = cooldownEnd.toISOString().split('T')[0];
      }
    }

    // ── New top-10 entries ───────────────────────────────────────────────
    const top10 = scored.filter(s => s.killRank <= TOP_N).slice(0, TOP_N);

    for (const stock of top10) {
      // Skip if already tracking
      if (activeStudies.some(s => s.ticker === stock.ticker)) continue;
      // Skip if in cooldown
      if (cooldownMap[stock.ticker] && friday < cooldownMap[stock.ticker]) continue;

      const study = {
        id:              `ai300-${stock.ticker}-${friday}`,
        ticker:          stock.ticker,
        direction:       stock.direction,
        signal:          stock.signal,
        sector:          stock.sectorName || '—',
        entryDate:       friday,
        entryPrice:      stock.currentPrice,
        entryRank:       stock.killRank,
        entryScore:      stock.total,
        entryTier:       stock.tierName,
        entryD3:         stock.scores.d3,
        entrySource:     'BACKFILL',
        stopPrice:       stock.stopPrice,
        status:          'ACTIVE',
        exitDate:        null,
        exitPrice:       null,
        exitReason:      null,
        pnlPct:          null,
        pnlDollar:       null,
        holdingWeeks:    0,
        maxFavorable:    0,
        maxAdverse:      0,
        weeklySnapshots: [],
        createdAt:       new Date(),
      };

      activeStudies.push(study);
      totalEntries++;
    }

    // Progress
    if (fridays.indexOf(friday) % 10 === 0) {
      const bullStr = pai300Bull == null ? 'N/A' : (pai300Bull ? 'BULL' : 'BEAR');
      process.stdout.write(`  ${friday} | scored=${scored.length} active=${activeStudies.length} closed=${closedStudies.length} regime=${bullStr}\r`);
    }
  }

  // Close remaining active studies as of today (mark them still ACTIVE)
  console.log('\n');

  // ── 8. Write all documents to MongoDB ─────────────────────────────────────
  const allStudies = [...closedStudies, ...activeStudies];
  console.log(`Total case studies: ${allStudies.length} (${closedStudies.length} closed, ${activeStudies.length} active)`);
  console.log(`Total entries: ${totalEntries}, Total exits: ${totalExits}`);

  if (allStudies.length > 0) {
    await db.collection('pnthr_ai300_kill_case_studies').insertMany(allStudies);
    console.log(`Inserted ${allStudies.length} case study documents`);
  }

  // Create indexes
  await db.collection('pnthr_ai300_kill_case_studies').createIndex({ ticker: 1, status: 1 });
  await db.collection('pnthr_ai300_kill_case_studies').createIndex({ status: 1, entryDate: -1 });
  await db.collection('pnthr_ai300_kill_case_studies').createIndex({ id: 1 }, { unique: true });

  // ── 9. Rebuild track record ───────────────────────────────────────────────
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
    byTier[t].count++;
    if ((s.pnlPct ?? 0) > 0) byTier[t].wins++;
    byTier[t].totalPnl += (s.pnlPct ?? 0);
  }
  for (const tier of Object.keys(byTier)) {
    byTier[tier].winRate = +(byTier[tier].wins / byTier[tier].count * 100).toFixed(1);
    byTier[tier].avgPnl  = +(byTier[tier].totalPnl / byTier[tier].count).toFixed(1);
    delete byTier[tier].totalPnl;
  }

  const byDirection = {};
  for (const dir of ['SHORT', 'LONG']) {
    const dt = closed.filter(s => s.direction === dir);
    const dw = dt.filter(s => (s.pnlPct ?? 0) > 0);
    byDirection[dir] = {
      count:   dt.length,
      winRate: dt.length > 0 ? +(dw.length / dt.length * 100).toFixed(1) : 0,
      avgPnl:  dt.length > 0 ? +(dt.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0) / dt.length).toFixed(1) : 0,
    };
  }

  const bySector = {};
  for (const s of closed) {
    const sec = s.sector || 'Unknown';
    if (!bySector[sec]) bySector[sec] = { count: 0, wins: 0, totalPnl: 0 };
    bySector[sec].count++;
    if ((s.pnlPct ?? 0) > 0) bySector[sec].wins++;
    bySector[sec].totalPnl += (s.pnlPct ?? 0);
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
    byMonth[month].trades++;
    byMonth[month].totalPnl += (s.pnlPct ?? 0);
  }
  const monthlyReturns = Object.entries(byMonth)
    .map(([month, data]) => ({
      month,
      trades: data.trades,
      avgPnl: +(data.totalPnl / data.trades).toFixed(1),
      totalPnl: +data.totalPnl.toFixed(1),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const asOf = new Date().toISOString().split('T')[0];
  const record = {
    asOf,
    totalTrades:     allStudies.length,
    activeTrades:    active.length,
    closedTrades:    closed.length,
    winRate:         closed.length > 0 ? +(winners.length / closed.length * 100).toFixed(1) : 0,
    avgWinPct:       winners.length > 0 ? +(grossWins  / winners.length).toFixed(1) : 0,
    avgLossPct:      losers.length  > 0 ? +(-grossLosses / losers.length).toFixed(1) : 0,
    avgHoldingWeeks: closed.length  > 0
      ? +(closed.reduce((sum, t) => sum + (t.holdingWeeks || 0), 0) / closed.length).toFixed(1)
      : 0,
    profitFactor:    grossLosses > 0
      ? +(grossWins / grossLosses).toFixed(2)
      : (grossWins > 0 ? 999 : 0),
    bigWinnerRate:   closed.length > 0 ? +(bigWinners.length / closed.length * 100).toFixed(1) : 0,
    byTier,
    byDirection,
    bySector,
    monthlyReturns,
    updatedAt: new Date(),
  };

  await db.collection('pnthr_ai300_kill_track_record').updateOne(
    { asOf },
    { $set: record },
    { upsert: true }
  );
  await db.collection('pnthr_ai300_kill_track_record').createIndex({ asOf: -1 });

  // ── 10. Print summary ─────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total trades:    ${allStudies.length}`);
  console.log(`  Active:          ${active.length}`);
  console.log(`  Closed:          ${closed.length}`);
  console.log(`  Winners:         ${winners.length} (${record.winRate}%)`);
  console.log(`  Losers:          ${losers.length}`);
  console.log(`  Avg Win:         +${record.avgWinPct}%`);
  console.log(`  Avg Loss:        ${record.avgLossPct}%`);
  console.log(`  Profit Factor:   ${record.profitFactor}x`);
  console.log(`  Big Winners:     ${bigWinners.length} (${record.bigWinnerRate}% of closed)`);
  console.log(`  Avg Holding:     ${record.avgHoldingWeeks} weeks`);
  console.log('');
  console.log('  By Tier:');
  for (const [tier, data] of Object.entries(byTier)) {
    console.log(`    ${tier.padEnd(18)} ${data.count} trades | WR: ${data.winRate}% | Avg: ${data.avgPnl > 0 ? '+' : ''}${data.avgPnl}%`);
  }
  console.log('');
  console.log('  By Direction:');
  for (const [dir, data] of Object.entries(byDirection)) {
    console.log(`    ${dir.padEnd(10)} ${data.count} trades | WR: ${data.winRate}% | Avg: ${data.avgPnl > 0 ? '+' : ''}${data.avgPnl}%`);
  }
  console.log('');
  console.log('  Monthly Returns:');
  for (const m of monthlyReturns) {
    console.log(`    ${m.month}: ${m.trades} trades | Total: ${m.totalPnl > 0 ? '+' : ''}${m.totalPnl}% | Avg: ${m.avgPnl > 0 ? '+' : ''}${m.avgPnl}%`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  AI 300 Kill 10 backfill complete ✓');
  console.log('═══════════════════════════════════════════════════════════════');

  await client.close();
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
