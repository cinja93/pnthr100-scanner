// server/ordersPipeline.js
// ── PNTHR Orders Pipeline: Filter → Rank → Generate Order Sheet ─────────────
//
// Implements the backtested top-down flow:
//   679 universe → MACRO gate → SECTOR gate → D2 gate → SS crash gate
//   → Re-rank survivors → Top 10 BL / Top 5 SS → Order instructions
//
// Called by:
//   - Friday 2:00 PM cron (PREVIEW)
//   - Friday 4:15 PM pipeline (CONFIRMED)
//   - Daily 4:40 PM cron (DAILY_UPDATE — lot additions, exits, stale hunts)
//   - Manual admin trigger
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import {
  getApexResults, getCachedApexResults, triggerApexWarmup,
  fetchIndexData, fetchStockData, fetchSectorData,
  SECTOR_MAP, ALL_SECTOR_ETFS,
} from './apexService.js';
import { getJungleStocks }               from './stockService.js';
import { getSignals }                     from './signalService.js';
import { getSp400Longs, getSp400Shorts }  from './sp400Service.js';
import { getPreyResults }                 from './preyService.js';
import { getLastFriday }                  from './technicalUtils.js';
import { DEMO_OWNER_ID }                  from './demoEngine.js';

const BL_TOP_N = 10;
const SS_TOP_N = 5;
const SS_SECTOR_5D_THRESHOLD = -3; // sector 5D momentum must be < -3% for SS

// ── Gate functions ──────────────────────────────────────────────────────────

function macroGate(stock, indexData) {
  const exc = (stock.exchange || '').toUpperCase();
  const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
  const idx = indexData[idxTicker] || indexData['SPY'];
  if (!idx) return { passed: false, reason: `No ${idxTicker} data` };

  if (stock.signal === 'BL' && !idx.aboveEma) {
    return { passed: false, reason: `${idxTicker} below 21W EMA — longs blocked` };
  }
  if (stock.signal === 'SS' && idx.aboveEma) {
    return { passed: false, reason: `${idxTicker} above 21W EMA — shorts blocked` };
  }
  return { passed: true, reason: `${idxTicker} ${idx.aboveEma ? 'above' : 'below'} EMA — ${stock.signal} aligned` };
}

function sectorGate(stock, sectorGateData) {
  const etf = SECTOR_MAP[stock.sector];
  if (!etf || !sectorGateData[etf]) {
    return { passed: true, reason: `Sector ${stock.sector} — no ETF data, passed through` };
  }
  const { aboveEma } = sectorGateData[etf];
  if (stock.signal === 'BL' && !aboveEma) {
    return { passed: false, reason: `${etf} (${stock.sector}) below 21W EMA — BL blocked` };
  }
  if (stock.signal === 'SS' && aboveEma) {
    return { passed: false, reason: `${etf} (${stock.sector}) above 21W EMA — SS blocked` };
  }
  return { passed: true, reason: `${etf} aligned with ${stock.signal}` };
}

function d2Gate(stock) {
  const d2Score = stock.scores?.d2 ?? stock.scoreDetail?.d2?.score ?? 0;
  if (d2Score < 0) {
    return { passed: false, reason: `D2 = ${d2Score} (sector fighting you)` };
  }
  return { passed: true, reason: `D2 = ${d2Score}` };
}

function ssCrashGate(stock, indexData, sectorGateData) {
  if (stock.signal !== 'SS') return { passed: true, reason: 'BL — crash gate N/A' };

  // Macro slope must be falling 2+ weeks
  const exc = (stock.exchange || '').toUpperCase();
  const idxTicker = (exc === 'NASDAQ' || exc.includes('NASDAQ')) ? 'QQQ' : 'SPY';
  const idx = indexData[idxTicker] || indexData['SPY'];
  if (!idx || idx.emaRising) {
    return { passed: false, reason: `${idxTicker} EMA not falling — SS crash gate blocked` };
  }

  // Sector 5D momentum must be < -3%
  const etf = SECTOR_MAP[stock.sector];
  if (!etf || !sectorGateData[etf]) {
    return { passed: false, reason: `No sector 5D data for ${stock.sector}` };
  }
  const { return5D } = sectorGateData[etf];
  if (return5D == null || return5D > SS_SECTOR_5D_THRESHOLD) {
    return { passed: false, reason: `${etf} 5D = ${return5D?.toFixed(1)}% (need < ${SS_SECTOR_5D_THRESHOLD}%)` };
  }

  return { passed: true, reason: `SS crash: ${idxTicker} EMA falling, ${etf} 5D = ${return5D.toFixed(1)}%` };
}

// ── Fetch enhanced sector gate data ─────────────────────────────────────────
// Extends the basic sector data with EMA relationship for the gate check.

async function fetchSectorGateData() {
  const result = {};
  const basicSectorData = await fetchSectorData();

  await Promise.all(ALL_SECTOR_ETFS.map(async (etf) => {
    try {
      const data = await fetchStockData(etf);
      if (!data) return;
      const { weekly, ema21 } = data;
      const n = weekly.length;
      const li = n - 1;
      if (!ema21[li]) return;

      result[etf] = {
        close:     weekly[li].close,
        ema21:     ema21[li],
        aboveEma:  weekly[li].close > ema21[li],
        emaRising: ema21[li] > (ema21[li - 1] || 0),
        return5D:  basicSectorData[etf]?.return5D ?? null,
        return1M:  basicSectorData[etf]?.return1M ?? null,
      };
    } catch { /* skip */ }
  }));

  return result;
}

// ── Main pipeline ───────────────────────────────────────────────────────────

export async function runOrdersPipeline({ type = 'WEEKLY' } = {}) {
  const db = await connectToDatabase();
  if (!db) throw new Error('Cannot connect to MongoDB');

  console.log(`[Orders] Running ${type} pipeline...`);

  // Step 1: Ensure Kill scores are computed
  let apexResults = getCachedApexResults();
  if (!apexResults) {
    console.log('[Orders] Cache cold — warming up Kill scores...');
    await triggerApexWarmup();
    apexResults = getCachedApexResults();
  }
  if (!apexResults?.stocks) throw new Error('No Kill scores available');

  const allStocks = apexResults.stocks;
  // Use cached indexData only if it has valid SPY + QQQ slope data.
  // apexResults.indexData can be { SPY: null, QQQ: null } when FMP failed during
  // apex scoring — that object is truthy so a simple || fallback never fires.
  const cachedIndex = apexResults.indexData;
  const indexData = (cachedIndex?.SPY?.emaSlope != null && cachedIndex?.QQQ?.emaSlope != null)
    ? cachedIndex
    : await fetchIndexData();
  const sectorGateData = await fetchSectorGateData();

  console.log(`[Orders] Starting with ${allStocks.length} scored stocks`);

  // Step 2: Filter to stocks with active signals
  const withSignals = allStocks.filter(s =>
    (s.signal === 'BL' || s.signal === 'SS') && !s.overextended && s.apexScore > 0
  );
  console.log(`[Orders] ${withSignals.length} stocks with active BL/SS signals`);

  // Step 3: Apply gates
  const gateLog = [];
  const survivors = [];

  for (const stock of withSignals) {
    const gates = [];

    // MACRO gate
    const macro = macroGate(stock, indexData);
    gates.push({ gate: 'MACRO', ...macro });
    if (!macro.passed) {
      gateLog.push({ ticker: stock.ticker, signal: stock.signal, gate: 'MACRO', passed: false, reason: macro.reason });
      continue;
    }

    // SECTOR gate
    const sector = sectorGate(stock, sectorGateData);
    gates.push({ gate: 'SECTOR', ...sector });
    if (!sector.passed) {
      gateLog.push({ ticker: stock.ticker, signal: stock.signal, gate: 'SECTOR', passed: false, reason: sector.reason });
      continue;
    }

    // D2 gate
    const d2 = d2Gate(stock);
    gates.push({ gate: 'D2', ...d2 });
    if (!d2.passed) {
      gateLog.push({ ticker: stock.ticker, signal: stock.signal, gate: 'D2', passed: false, reason: d2.reason });
      continue;
    }

    // SS crash gate (SS only)
    if (stock.signal === 'SS') {
      const crash = ssCrashGate(stock, indexData, sectorGateData);
      gates.push({ gate: 'SS_CRASH', ...crash });
      if (!crash.passed) {
        gateLog.push({ ticker: stock.ticker, signal: stock.signal, gate: 'SS_CRASH', passed: false, reason: crash.reason });
        continue;
      }
    }

    survivors.push({ ...stock, gatesPassed: gates });
    gateLog.push({ ticker: stock.ticker, signal: stock.signal, gate: 'ALL', passed: true, reason: gates.map(g => g.reason).join(' | ') });
  }

  console.log(`[Orders] ${survivors.length} stocks passed all gates (${survivors.filter(s => s.signal === 'BL').length} BL, ${survivors.filter(s => s.signal === 'SS').length} SS)`);

  // Step 4: Re-rank by Kill score within filtered pool
  const blPool = survivors.filter(s => s.signal === 'BL').sort((a, b) => b.apexScore - a.apexScore);
  const ssPool = survivors.filter(s => s.signal === 'SS').sort((a, b) => b.apexScore - a.apexScore);

  // Assign filtered ranks
  blPool.forEach((s, i) => { s.filteredRank = i + 1; });
  ssPool.forEach((s, i) => { s.filteredRank = i + 1; });

  // Step 5: Take top N
  const blOrders = blPool.slice(0, BL_TOP_N);
  const ssOrders = ssPool.slice(0, SS_TOP_N);
  const allOrders = [...blOrders, ...ssOrders];

  console.log(`[Orders] Selected ${blOrders.length} BL + ${ssOrders.length} SS = ${allOrders.length} orders`);

  // Step 6: Build order instructions
  const weekOf = getLastFriday();
  const orders = allOrders.map(stock => ({
    ticker:         stock.ticker,
    companyName:    stock.companyName,
    signal:         stock.signal,
    direction:      stock.signal === 'BL' ? 'LONG' : 'SHORT',
    killScore:      stock.apexScore,
    killRank:       stock.killRank,        // original full-universe rank
    filteredRank:   stock.filteredRank,     // rank within filtered pool
    tier:           stock.tier,
    sector:         stock.sector,
    exchange:       stock.exchange,
    entryPrice:     stock.stopPrice ? stock.currentPrice : stock.currentPrice, // limit order at current signal level
    signalPrice:    stock.scoreDetail?.d3?.entryPrice || stock.currentPrice,   // breakout/breakdown level
    stopPrice:      stock.stopPrice || null,
    currentPrice:   stock.currentPrice,
    d2Score:        stock.scores?.d2 ?? 0,
    d3Confirmation: stock.confirmation,
    signalAge:      stock.signalAge,
    weeklyRsi:      stock.weeklyRsi,
    gatesPassed:    stock.gatesPassed,
  }));

  // Step 7: Build regime snapshot
  const spy = indexData.SPY || {};
  const qqq = indexData.QQQ || {};
  const regime = {
    spyAboveEma:  spy.aboveEma  ?? null,
    spyEmaRising: spy.emaRising ?? null,
    spyPrice:     spy.price     ?? null,
    spyEma21:     spy.ema21     ?? null,
    spyEmaSlope:  spy.emaSlope  ?? null,
    qqqAboveEma:  qqq.aboveEma  ?? null,
    qqqEmaRising: qqq.emaRising ?? null,
    qqqPrice:     qqq.price     ?? null,
    qqqEma21:     qqq.ema21     ?? null,
    qqqEmaSlope:  qqq.emaSlope  ?? null,
  };

  // Determine mode
  const ssCrashActive = ssOrders.length > 0;
  const macroDirection = spy.aboveEma ? 'BULLISH' : 'BEARISH';
  let mode = 'LONGS ONLY';
  if (ssCrashActive) mode = 'LONGS + SS CRASH';
  if (!spy.aboveEma && !qqq.aboveEma && ssOrders.length > 0) mode = 'CRASH MODE';
  if (allOrders.length === 0) mode = 'NO TRADES';

  // Build sector summary
  const sectorSummary = {};
  for (const etf of ALL_SECTOR_ETFS) {
    const d = sectorGateData[etf];
    if (!d) continue;
    const sectorName = Object.entries(SECTOR_MAP).find(([, v]) => v === etf)?.[0] || etf;
    sectorSummary[etf] = {
      sector:    sectorName,
      close:     d.close,
      ema21:     d.ema21,
      aboveEma:  d.aboveEma,
      return5D:  d.return5D,
      return1M:  d.return1M,
    };
  }

  // Stats
  const stats = {
    totalScored:     allStocks.length,
    withSignals:     withSignals.length,
    macroFiltered:   gateLog.filter(g => g.gate === 'MACRO' && !g.passed).length,
    sectorFiltered:  gateLog.filter(g => g.gate === 'SECTOR' && !g.passed).length,
    d2Filtered:      gateLog.filter(g => g.gate === 'D2' && !g.passed).length,
    ssCrashFiltered: gateLog.filter(g => g.gate === 'SS_CRASH' && !g.passed).length,
    survivors:       survivors.length,
    blSurvivors:     blPool.length,
    ssSurvivors:     ssPool.length,
    blSelected:      blOrders.length,
    ssSelected:      ssOrders.length,
  };

  // Step 8: Persist to MongoDB (one doc per week per type)
  const orderDoc = {
    weekOf,
    type,
    generatedAt: new Date(),
    regime,
    mode,
    macroDirection,
    ssCrashActive,
    sectorSummary,
    orders,
    stats,
    gateLog: gateLog.slice(0, 100), // Keep top 100 gate entries to avoid bloat
  };

  const col = db.collection('pnthr_orders');
  await col.createIndex({ weekOf: -1, type: 1 });

  await col.updateOne(
    { weekOf, type },
    { $set: orderDoc },
    { upsert: true }
  );

  console.log(`[Orders] ${type} order sheet saved: ${orders.length} orders, mode=${mode}`);

  // Log the order sheet
  if (orders.length > 0) {
    console.log(`\n[Orders] ── ${type} ORDER SHEET — ${weekOf} ──`);
    console.log(`[Orders] MACRO: SPY ${spy.aboveEma ? '↑ ABOVE' : '↓ BELOW'} EMA (slope ${spy.emaSlope?.toFixed(2)}%) | QQQ ${qqq.aboveEma ? '↑ ABOVE' : '↓ BELOW'} EMA (slope ${qqq.emaSlope?.toFixed(2)}%)`);
    console.log(`[Orders] MODE: ${mode}`);
    console.log(`[Orders] FILTERED: ${stats.totalScored} scored → ${stats.withSignals} signals → ${stats.survivors} passed gates → ${orders.length} selected\n`);

    for (const o of orders) {
      const action = o.signal === 'BL' ? 'BUY ' : 'SHORT';
      console.log(`[Orders]   ${action}  ${o.ticker.padEnd(6)} at $${o.signalPrice?.toFixed(2) || '?'}  stop $${o.stopPrice?.toFixed(2) || '?'}  Kill: ${o.killScore}  #${o.filteredRank} (was #${o.killRank})  ${o.tier}`);
    }
    console.log('');
  } else {
    console.log(`[Orders] NO TRADES THIS WEEK — ${stats.macroFiltered + stats.sectorFiltered + stats.d2Filtered + stats.ssCrashFiltered} stocks filtered out`);
  }

  return orderDoc;
}

// ── Daily position update ───────────────────────────────────────────────────
// Checks open positions for lot additions, stop hits, stale hunts.

export async function runOrdersDailyUpdate() {
  const db = await connectToDatabase();
  if (!db) return;

  console.log('[Orders Daily] Checking open positions...');

  const profiles = await db.collection('user_profiles').find({ accountSize: { $gt: 0 } }).toArray();
  const ownerIds = [
    ...profiles.map(p => p.userId || p._id?.toString()),
    DEMO_OWNER_ID,
  ];

  for (const ownerId of ownerIds) {
    try {
      const positions = await db.collection('pnthr_portfolio')
        .find({ ownerId, status: 'ACTIVE' }).toArray();

      if (positions.length === 0) continue;

      const updates = [];
      for (const pos of positions) {
        // Count trading days since entry
        const entryDate = pos.fills?.[0]?.date ? new Date(pos.fills[0].date) : new Date(pos.createdAt);
        const now = new Date();
        let tradingDays = 0;
        const d = new Date(entryDate);
        while (d < now) {
          d.setDate(d.getDate() + 1);
          const dow = d.getDay();
          if (dow !== 0 && dow !== 6) tradingDays++;
        }

        // Determine lot status
        const filledLots = (pos.fills || []).filter(f => f.filled).length;
        const nextLot = filledLots + 1;
        const lastFillDay = pos.fills?.[filledLots - 1]?.tradingDay || 0;
        const timeGateCleared = tradingDays - lastFillDay >= 5;

        const update = {
          ticker:     pos.ticker,
          signal:     pos.signal || (pos.direction === 'SHORT' ? 'SS' : 'BL'),
          tradingDays,
          filledLots,
          nextLot:    nextLot <= 5 ? nextLot : null,
          timeGateCleared: nextLot <= 5 ? timeGateCleared : false,
          action:     null,
          reason:     null,
        };

        // Stale hunt check (20+ days unprofitable)
        if (tradingDays >= 20 && pos.currentPnlPct != null && pos.currentPnlPct < 0) {
          update.action = 'EXIT';
          update.reason = `STALE HUNT — Day ${tradingDays}, P&L ${pos.currentPnlPct.toFixed(1)}%`;
        }
        // Lot addition check
        else if (nextLot <= 5 && timeGateCleared && pos.currentPnlPct > 1) {
          update.action = 'ADD_LOT';
          update.reason = `ADD LOT ${nextLot} — Day ${tradingDays}, +${pos.currentPnlPct.toFixed(1)}% profitable`;
        }

        if (update.action) updates.push(update);
      }

      if (updates.length > 0) {
        const weekOf = getLastFriday();
        await db.collection('pnthr_orders').updateOne(
          { weekOf, type: 'DAILY_UPDATE', ownerId },
          { $set: {
            weekOf,
            type: 'DAILY_UPDATE',
            ownerId,
            generatedAt: new Date(),
            updates,
          }},
          { upsert: true }
        );
        console.log(`[Orders Daily] ${ownerId}: ${updates.length} actions — ${updates.map(u => `${u.action} ${u.ticker}`).join(', ')}`);
      }
    } catch (err) {
      console.warn(`[Orders Daily] Error for ${ownerId}:`, err.message);
    }
  }
}

// ── API handler: GET /api/orders/latest ─────────────────────────────────────

export async function ordersGetLatest(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const weekOf = getLastFriday();

    // Get the most recent order sheet (prefer CONFIRMED over WEEKLY)
    let orderDoc = await db.collection('pnthr_orders').findOne(
      { weekOf, type: 'CONFIRMED' }
    );
    if (!orderDoc) {
      orderDoc = await db.collection('pnthr_orders').findOne(
        { weekOf, type: 'WEEKLY' }
      );
    }

    // Get daily updates for this user
    const dailyUpdate = await db.collection('pnthr_orders').findOne(
      { weekOf, type: 'DAILY_UPDATE', ownerId: req.user.userId }
    );

    // Get user's active positions for "in portfolio" flag
    const portfolio = await db.collection('pnthr_portfolio')
      .find({ status: 'ACTIVE', ownerId: req.user.userId }).project({ ticker: 1 }).toArray();
    const inPort = new Set(portfolio.map(p => p.ticker));

    // Enrich orders with portfolio status
    const orders = (orderDoc?.orders || []).map(o => ({
      ...o,
      inPortfolio: inPort.has(o.ticker),
    }));

    // If saved regime is missing index data (FMP failed when orders were generated),
    // do a live re-fetch so the MACRO bar always shows real values.
    let regime = orderDoc?.regime || null;
    if (regime && (regime.spyPrice == null || regime.spyEmaSlope == null || regime.qqqPrice == null || regime.qqqEmaSlope == null)) {
      try {
        const liveIndex = await fetchIndexData();
        if (liveIndex.SPY) {
          regime = { ...regime, spyPrice: liveIndex.SPY.price, spyEma21: liveIndex.SPY.ema21, spyEmaSlope: liveIndex.SPY.emaSlope, spyAboveEma: liveIndex.SPY.aboveEma, spyEmaRising: liveIndex.SPY.emaRising };
        }
        if (liveIndex.QQQ) {
          regime = { ...regime, qqqPrice: liveIndex.QQQ.price, qqqEma21: liveIndex.QQQ.ema21, qqqEmaSlope: liveIndex.QQQ.emaSlope, qqqAboveEma: liveIndex.QQQ.aboveEma, qqqEmaRising: liveIndex.QQQ.emaRising };
        }
      } catch (e) {
        console.warn('[Orders API] Could not re-fetch index data for MACRO bar:', e.message);
      }
    }

    res.json({
      weekOf:          orderDoc?.weekOf || weekOf,
      type:            orderDoc?.type || null,
      generatedAt:     orderDoc?.generatedAt || null,
      regime,
      mode:            orderDoc?.mode || 'NO DATA',
      macroDirection:  orderDoc?.macroDirection || null,
      ssCrashActive:   orderDoc?.ssCrashActive || false,
      sectorSummary:   orderDoc?.sectorSummary || {},
      orders,
      stats:           orderDoc?.stats || null,
      dailyUpdates:    dailyUpdate?.updates || [],
    });
  } catch (err) {
    console.error('[Orders API] Error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── API handler: GET /api/orders/gate-log ───────────────────────────────────

export async function ordersGetGateLog(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const weekOf = getLastFriday();
    const orderDoc = await db.collection('pnthr_orders').findOne(
      { weekOf, type: { $in: ['CONFIRMED', 'WEEKLY'] } },
      { sort: { type: 1 } } // CONFIRMED sorts before WEEKLY
    );

    res.json({
      weekOf:  orderDoc?.weekOf || weekOf,
      stats:   orderDoc?.stats || null,
      gateLog: orderDoc?.gateLog || [],
    });
  } catch (err) {
    console.error('[Orders GateLog] Error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── API handler: GET /api/orders/history ────────────────────────────────────

export async function ordersGetHistory(req, res) {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    const limit = parseInt(req.query.limit) || 10;
    const docs = await db.collection('pnthr_orders')
      .find({ type: { $in: ['CONFIRMED', 'WEEKLY'] } })
      .sort({ weekOf: -1 })
      .limit(limit)
      .project({ gateLog: 0 }) // Exclude verbose gate log from history
      .toArray();

    res.json({ history: docs });
  } catch (err) {
    console.error('[Orders History] Error:', err);
    res.status(500).json({ error: err.message });
  }
}
