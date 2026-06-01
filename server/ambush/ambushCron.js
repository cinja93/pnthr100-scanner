// server/ambush/ambushCron.js
// ── PNTHR AMBUSH V7.3 — 60-Second Live Tick Processor ─────────────────────
//
// Ticks every 60 seconds during market hours (9:30-16:05 ET, Mon-Fri).
//
// Data sources:
//   - IBKR bridge (via pnthr_ibkr_positions) → live marketPrice for held tickers
//   - FMP /quote batch → live price for non-held tickers (STALKING, candidates)
//   - FMP /historical-chart/1hour → only for narrow MCE breakout confirmation
//
// Synthetic bars: each 60-second price tick is accumulated into hourly OHLC
// bars stored on the position document. When the hour rolls over, the bar
// finalizes and becomes prevSyntheticBar. Breakout detection and trailing
// exit use these synthetic bars — identical logic to V7 backtest, just built
// from live prices instead of FMP historical charts.
//
// First-hour tracking (9:30-10:30): todayFirstHourLow/High accumulated from
// live prices. After 10:30, used for 1H stop and trailing ratchet.
//
// Order execution: IBKR bridge via pnthr_ambush_outbox (unchanged).
//
// Flow per tick:
//   1. Fetch live prices (IBKR for held, FMP /quote for non-held)
//   2. Load signal context (weekly signals, regime, sector gates)
//   3. Update synthetic bars + first-hour tracking
//   4. Process ACTIVE/PROTECT (stops, lots, Break Even, trailing)
//   5. Process ATTACK (execute pending re-entries)
//   6. Process STALKING (check for breakout via synthetic bars)
//   7. Scan for new MCE entries (FMP hourly for narrow breakout check)
//   8. Write state changes to MongoDB
//   9. Enqueue order commands to outbox
// ────────────────────────────────────────────────────────────────────────────

import { connectToDatabase, getUserProfile } from '../database.js';
import {
  STATES, BE_THRESHOLD, STRIKE_PCT, LOT_OFFSETS, SLIPPAGE_BPS,
  FIRST_HOUR_END, WITHDRAWAL_THRESHOLD, WITHDRAWAL_AMOUNT,
  COMMISSION_PER_SHARE,
  isConfirmedGreenBreakout, isConfirmedRedBreakdown,
  entrySlip, exitSlip, extractTime, sizeLots,
  getSizingMultiplier, getSizingTierLabel,
  loadSignalContext, getRegime, getSectorOk, isActiveBL, isActiveSS,
  getAiTickers, getSectorName,
} from './ambushEngine.js';
import { calcCommission, calcBorrowCost } from '../backtest/costEngine.js';
import {
  getAmbushPositions, getAmbushPosition, upsertAmbushPosition,
  deleteAmbushPosition, logAmbushTrade, enqueueAmbushOrder,
  getAmbushConfig, updateAmbushConfig, recordAmbushAum,
} from './ambushStateManager.js';

const FMP_API_KEY = process.env.FMP_API_KEY;

// ── Eastern Time Helpers ───────────────────────────────────────────────────

function getETComponents(now = new Date()) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now)) {
    parts[type] = value;
  }
  // en-CA formats as YYYY-MM-DD
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parts.hour === '24' ? '00' : parts.hour; // midnight edge
  return {
    date,
    hour,
    minute: parts.minute,
    hourKey: `${date}T${hour}`,
    timeStr: `${hour}:${parts.minute}`,
    totalMinutes: parseInt(hour, 10) * 60 + parseInt(parts.minute, 10),
  };
}

function getTodayET() {
  return getETComponents().date;
}

function isMarketHours() {
  const { totalMinutes } = getETComponents();
  const now = new Date();
  const dow = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  if (dow === 'Sat' || dow === 'Sun') return false;
  return totalMinutes >= 570 && totalMinutes <= 965; // 9:30 AM - 4:05 PM ET
}

// ── Data Source: IBKR Live Prices ──────────────────────────────────────────
// Reads marketPrice from pnthr_ibkr_positions (synced by bridge every 60s).
// Returns { ticker: price } for all positions the bridge reports.

async function fetchIbkrPrices(db, ownerId) {
  const prices = {};
  if (!ownerId) return prices;

  try {
    const doc = await db.collection('pnthr_ibkr_positions').findOne({ ownerId });
    if (doc?.positions && Array.isArray(doc.positions)) {
      for (const pos of doc.positions) {
        const price = pos.marketPrice;
        if (pos.symbol && typeof price === 'number' && price > 0.01 && price < 50000) {
          prices[pos.symbol] = +price.toFixed(4);
        }
      }
    }
    // Staleness warning
    if (doc?.syncedAt) {
      const age = Date.now() - new Date(doc.syncedAt).getTime();
      if (age > 300_000) {
        console.warn(`[Ambush] IBKR data is ${Math.round(age / 1000)}s stale — bridge may be down`);
      }
    }
  } catch (err) {
    console.warn('[Ambush] Failed to read IBKR positions:', err.message);
  }

  return prices;
}

// ── Data Source: FMP Batch Quotes ──────────────────────────────────────────
// Lightweight: one API call per 50 tickers. Returns { ticker: price }.
// Used for non-held tickers (STALKING, ATTACK, MCE candidates).

async function fetchFmpBatchQuotes(tickers) {
  const prices = {};
  if (!tickers.length || !FMP_API_KEY) return prices;

  const batchSize = 50;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    try {
      const symbols = batch.join(',');
      const url = `https://financialmodelingprep.com/api/v3/quote/${symbols}?apikey=${FMP_API_KEY}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (Array.isArray(data)) {
        for (const q of data) {
          if (q.symbol && typeof q.price === 'number' && q.price > 0) {
            prices[q.symbol] = +q.price.toFixed(4);
          }
        }
      }
    } catch (err) {
      console.warn(`[Ambush] FMP batch quote failed:`, err.message);
    }
  }

  return prices;
}

// ── Data Source: Combined Live Prices ──────────────────────────────────────
// Merges IBKR (held tickers) + FMP quotes (non-held). IBKR takes priority.

async function fetchLivePrices(db, positions, candidateTickers, ownerId) {
  // 1. IBKR prices for held tickers
  const ibkrPrices = await fetchIbkrPrices(db, ownerId);

  // 2. Determine which tickers still need prices
  const needFmp = new Set();
  for (const pos of positions) {
    if (!ibkrPrices[pos.ticker]) needFmp.add(pos.ticker);
  }
  for (const t of candidateTickers) {
    if (!ibkrPrices[t]) needFmp.add(t);
  }

  // 3. FMP batch quote for non-IBKR tickers
  const fmpPrices = needFmp.size > 0 ? await fetchFmpBatchQuotes([...needFmp]) : {};

  // 4. Merge: IBKR takes priority
  const merged = { ...fmpPrices, ...ibkrPrices };
  return merged;
}

// ── Data Source: Prior-Day Data (cached per day, for MCE 2-day trigger) ────
// Fetches last 5 daily bars per ticker from FMP. Cached in memory — only
// re-fetched when the date changes. Returns { ticker: { highs, lows } }.

let _priorDayCache = { date: null, data: {} };

async function fetchPriorDayData(tickers, today) {
  if (_priorDayCache.date === today && Object.keys(_priorDayCache.data).length > 0) {
    return _priorDayCache.data;
  }

  console.log(`[Ambush] Fetching prior-day data for ${tickers.length} MCE candidates...`);
  const data = {};
  const batchSize = 5;

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        try {
          const url = `https://financialmodelingprep.com/api/v3/historical-chart/1day/${ticker}?apikey=${FMP_API_KEY}`;
          const resp = await fetch(url);
          if (!resp.ok) return { ticker, bars: [] };
          const raw = await resp.json();
          const bars = (Array.isArray(raw) ? raw : []).slice(0, 5).reverse();
          return { ticker, bars };
        } catch {
          return { ticker, bars: [] };
        }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const { ticker, bars } = r.value;
        const priorBars = bars.filter(b => !b.date?.startsWith(today));
        const lastTwo = priorBars.slice(-2);
        if (lastTwo.length > 0) {
          data[ticker] = {
            highs: lastTwo.map(b => +b.high),
            lows: lastTwo.map(b => +b.low),
          };
        }
      }
    }
  }

  _priorDayCache = { date: today, data };
  console.log(`[Ambush] Cached prior-day data for ${Object.keys(data).length} tickers`);
  return data;
}

// ── Data Source: FMP Hourly Bars (MCE breakout confirmation only) ──────────
// Used ONLY for the narrow set of MCE candidates that pass all pre-filters.
// Typically 5-20 tickers per tick. Fetches today's hourly bars for pattern check.

async function fetchFmpHourlyBars(tickers) {
  const barMap = {};
  if (!tickers.length || !FMP_API_KEY) return barMap;

  const batchSize = 5;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        try {
          const url = `https://financialmodelingprep.com/api/v3/historical-chart/1hour/${ticker}?apikey=${FMP_API_KEY}`;
          const resp = await fetch(url);
          if (!resp.ok) return { ticker, bars: [] };
          const data = await resp.json();
          const bars = (Array.isArray(data) ? data : []).reverse().map(b => ({
            date: b.date,
            open: +b.open,
            high: +b.high,
            low: +b.low,
            close: +b.close,
            volume: +b.volume,
          }));
          return { ticker, bars };
        } catch (err) {
          console.error(`[Ambush] FMP hourly fetch failed for ${ticker}:`, err.message);
          return { ticker, bars: [] };
        }
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        barMap[r.value.ticker] = r.value.bars;
      }
    }
  }
  return barMap;
}

// ── Synthetic Bar Functions ────────────────────────────────────────────────
// Builds hourly OHLC bars from 60-second price ticks.
// Stored on the position document: syntheticBar (current), prevSyntheticBar.

function updateSyntheticBarOnPosition(pos, price, hourKey, today) {
  if (typeof price !== 'number' || price <= 0) return;

  // Day rollover: reset daily tracking
  if (pos.todayDate !== today) {
    pos.todayDate = today;
    pos.todayFirstHourLow = null;
    pos.todayFirstHourHigh = null;
    // Keep prevSyntheticBar from yesterday for trailing LL check continuity.
    // The consecutiveLowerLows counter + prevBarLow persist across days
    // (same as the hourly model where the engine only processes today's bars
    // but the counter carries over).
    pos.syntheticBar = null;
  }

  // Hour rollover: finalize current bar, promote to prev.
  // Keep ONE extra bar of history (prevBarLow/High = the bar before prevSyntheticBar)
  // so the V7.3 2-bar exit can test "last completed bar made a lower low than the one before it".
  if (pos.syntheticBar && pos.syntheticBar.hourKey !== hourKey) {
    if (pos.prevSyntheticBar) {
      pos.prevBarLow = pos.prevSyntheticBar.low;
      pos.prevBarHigh = pos.prevSyntheticBar.high;
    }
    pos.prevSyntheticBar = { ...pos.syntheticBar };
    pos.syntheticBar = null;
  }

  // Update or create current bar
  if (!pos.syntheticBar) {
    pos.syntheticBar = {
      hourKey,
      open: price,
      high: price,
      low: price,
      close: price,
    };
  } else {
    pos.syntheticBar.high = Math.max(pos.syntheticBar.high, price);
    pos.syntheticBar.low = Math.min(pos.syntheticBar.low, price);
    pos.syntheticBar.close = price;
  }
}

function updateFirstHourTracking(pos, price) {
  if (typeof price !== 'number' || price <= 0) return;
  if (pos.todayFirstHourLow === null || pos.todayFirstHourLow === undefined || price < pos.todayFirstHourLow) {
    pos.todayFirstHourLow = +price.toFixed(4);
  }
  if (pos.todayFirstHourHigh === null || pos.todayFirstHourHigh === undefined || price > pos.todayFirstHourHigh) {
    pos.todayFirstHourHigh = +price.toFixed(4);
  }
}

// ── Main Cron Tick ──────────────────────────────────────────────────────────

let _tickRunning = false;

export async function runAmbushTick() {
  if (_tickRunning) {
    console.warn('[Ambush] Tick already in progress — skipping');
    return { skipped: 'ALREADY_RUNNING' };
  }
  _tickRunning = true;
  try {
    return await _runAmbushTickInner();
  } finally {
    _tickRunning = false;
  }
}

async function _runAmbushTickInner() {
  const db = await connectToDatabase();
  if (!db) { console.error('[Ambush] No DB'); return { error: 'NO_DB' }; }

  const config = await getAmbushConfig(db);
  if (!config.enabled) {
    return { skipped: 'DISABLED' };
  }

  if (!isMarketHours()) {
    return { skipped: 'OUTSIDE_HOURS' };
  }

  const now = new Date();
  const et = getETComponents(now);
  const today = et.date;
  const hourKey = et.hourKey;
  const isFirstHour = et.totalMinutes < 630; // before 10:30 ET
  const maxPositions = config.maxPositions || 999;

  // ── Live NAV: read IBKR-synced accountSize from user profile ──────────
  let nav = config.nav || 83000;
  let navSource = 'config';
  if (config.ownerId) {
    try {
      const profile = await getUserProfile(config.ownerId);
      if (profile?.accountSize && profile.accountSize > 0) {
        nav = profile.accountSize;
        navSource = 'IBKR';
      }
    } catch (err) {
      console.warn(`[Ambush] Could not read user profile for NAV - using config.nav ($${nav}):`, err.message);
    }
  }

  // ── V7.3 withdrawal rule: at $2M, bank $1M and trade only the remainder ──
  // The engine CANNOT move money. It sizes off the reduced "trading NAV" and raises
  // an alert telling the admin to manually withdraw $1M. Once the cash is actually
  // pulled (real IBKR NAV drops below the threshold), tradingNav == real NAV again.
  let tradingNav = nav;
  let withdrawalAlert = null;
  if (nav >= WITHDRAWAL_THRESHOLD) {
    tradingNav = nav - WITHDRAWAL_AMOUNT;
    withdrawalAlert = {
      due: true,
      amount: WITHDRAWAL_AMOUNT,
      nav,
      tradingNav,
      message: `Account hit $${nav.toLocaleString()} — withdraw $${WITHDRAWAL_AMOUNT.toLocaleString()} and trade off $${tradingNav.toLocaleString()} (V7.3 rule).`,
    };
    console.warn(`[Ambush] WITHDRAWAL ALERT: ${withdrawalAlert.message}`);
  }

  const sizeMult = getSizingMultiplier(tradingNav);
  const sizeTier = getSizingTierLabel(tradingNav);
  console.log(`[Ambush] Tick ${et.timeStr} ET - NAV: $${nav.toLocaleString()} (${navSource})${tradingNav !== nav ? ` → trading $${tradingNav.toLocaleString()}` : ''}, Sizing: ${sizeTier}${isFirstHour ? ' [FIRST HOUR]' : ''}`);

  // 1. Load signal context (weekly signals, regime, sectors)
  const ctx = await loadSignalContext(db);

  // 2. Get all current Ambush positions
  const allPositions = await getAmbushPositions(db);

  // ── V7.3 cash gate: approximate available cash = tradingNav - capital deployed in
  // open positions. Mirrors the backtest's cash-skip so we never queue an entry we
  // can't fund. Conservative (overstates deployed); IBKR buying power is the backstop.
  let deployedCapital = 0;
  for (const p of allPositions) {
    if ((p.state === STATES.ACTIVE || p.state === STATES.PROTECT) && p.avgCost && p.totalShares) {
      deployedCapital += p.avgCost * p.totalShares;
    }
  }
  let availableCash = Math.max(0, tradingNav - deployedCapital);

  // 3. Determine MCE candidate tickers (not already tracked)
  const existingTickers = new Set(allPositions.map(p => p.ticker));
  const mceCandidates = [];
  if (!isFirstHour) {
    for (const ticker of getAiTickers()) {
      if (existingTickers.has(ticker)) continue;
      if (isActiveBL(ctx, ticker, today) || isActiveSS(ctx, ticker, today)) {
        mceCandidates.push(ticker);
      }
    }
  }

  // 4. Fetch live prices: IBKR for held, FMP quotes for non-held + candidates
  const livePrices = await fetchLivePrices(db, allPositions, mceCandidates, config.ownerId);
  const priceCount = Object.keys(livePrices).length;
  console.log(`[Ambush] Live prices: ${priceCount} tickers (${allPositions.length} positions + ${mceCandidates.length} candidates)`);

  // 5. Update synthetic bars for all tracked positions
  for (const pos of allPositions) {
    const price = livePrices[pos.ticker];
    if (price) {
      updateSyntheticBarOnPosition(pos, price, hourKey, today);
      if (isFirstHour) updateFirstHourTracking(pos, price);
    }
  }

  const actions = [];
  const errors = [];

  // ═══ PHASE A: Process existing ACTIVE + PROTECT positions ═══
  const activePositions = allPositions.filter(p =>
    p.state === STATES.ACTIVE || p.state === STATES.PROTECT
  );

  for (const pos of activePositions) {
    try {
      const price = livePrices[pos.ticker];
      if (!price) continue;

      const isLong = pos.direction === 'LONG';

      // ── During first hour: only collect data, skip price checks ──
      if (isFirstHour) {
        await upsertAmbushPosition(db, pos.ticker, {
          syntheticBar: pos.syntheticBar,
          prevSyntheticBar: pos.prevSyntheticBar,
          todayFirstHourLow: pos.todayFirstHourLow,
          todayFirstHourHigh: pos.todayFirstHourHigh,
          todayDate: pos.todayDate,
          livePrice: price,
          livePriceAt: now,
        });
        continue;
      }

      // V7.3 lot-based trailing: NO daily first-hour-low ratchet.
      let exited = false;

      // Close the position, log the trade, drop to STALKING, queue the exit order.
      const doLiveExit = async (exitLevel, exitType, actionType) => {
        const exitPrice = exitSlip(exitLevel, pos.direction);
        const comm = calcCommission(pos.totalShares, exitPrice);
        let pnl, borrow = 0;
        if (isLong) {
          pnl = +(pos.totalShares * exitPrice - comm - pos.totalShares * pos.avgCost).toFixed(2);
        } else {
          const entryD = pos.entryDate ? new Date(pos.entryDate) : new Date();
          const exitD = new Date(today);
          const tradingDays = Math.max(1, Math.round((exitD - entryD) / 86400000 * 5 / 7));
          borrow = calcBorrowCost(pos.totalShares, pos.avgCost, tradingDays, getSectorName(pos.ticker));
          pnl = +(pos.totalShares * (pos.avgCost - exitPrice) - comm - borrow).toFixed(2);
        }
        const trade = {
          ticker: pos.ticker, direction: pos.direction, entryPrice: pos.avgCost,
          exitPrice, shares: pos.totalShares, pnl, entryDate: pos.entryDate,
          exitDate: today, exitType, cycleNum: pos.cycleNum,
          commission: comm, peakProfit: pos.peak,
        };
        if (borrow) trade.borrow = borrow;
        await logAmbushTrade(db, trade);
        await upsertAmbushPosition(db, pos.ticker, {
          state: STATES.STALKING, direction: pos.direction, originalEntry: pos.originalEntry,
          runningLow: isLong ? price : (pos.runningLow || pos.syntheticBar?.low || price),
          runningHigh: isLong ? (pos.runningHigh || pos.syntheticBar?.high || price) : price,
          cycleNum: (pos.cycleNum || 0) + 1,
          entryPrice: null, avgCost: null, totalShares: 0, lotPlan: null, nextLot: 0, stop: null,
          atBE: false, trailingActive: false, beDate: null, peak: 0,
          prevBarLow: null, prevBarHigh: null, syntheticBar: null, prevSyntheticBar: null,
          todayFirstHourLow: pos.todayFirstHourLow, todayFirstHourHigh: pos.todayFirstHourHigh,
          todayDate: today, livePrice: price, livePriceAt: now,
        });
        await enqueueAmbushOrder(db, isLong ? 'SELL_EXIT' : 'COVER_EXIT', {
          ticker: pos.ticker, shares: pos.totalShares, direction: pos.direction, reason: exitType,
        });
        actions.push({ type: actionType, ticker: pos.ticker, pnl });
        exited = true;
      };

      // Check A: Lot trigger (fill first, then the stop follows the lots).
      if (pos.nextLot <= 4 && pos.lotPlan) {
        const offset = LOT_OFFSETS[pos.nextLot];
        const lotTrigger = isLong
          ? +(pos.originalEntry * (1 + offset)).toFixed(2)
          : +(pos.originalEntry * (1 - offset)).toFixed(2);
        const triggered = isLong ? price >= lotTrigger : price <= lotTrigger;
        if (triggered) {
          const lotShares = pos.lotPlan[pos.nextLot];
          const fillPrice = isLong ? entrySlip(lotTrigger, 'LONG') : entrySlip(lotTrigger, 'SHORT');
          const oldCost = pos.avgCost * pos.totalShares;
          pos.totalShares += lotShares;
          pos.avgCost = +((oldCost + fillPrice * lotShares) / pos.totalShares).toFixed(4);
          pos.nextLot++;

          // V7.3: post-BE, stop moves to the PREVIOUS lot's trigger price,
          // but NEVER worse than the recomputed breakeven (guardrail).
          if (pos.atBE) {
            const feePer = calcCommission(pos.totalShares, pos.avgCost) / pos.totalShares;
            const breakeven = isLong
              ? +(pos.avgCost + feePer).toFixed(2)
              : +(pos.avgCost - feePer).toFixed(2);
            const prevLotIdx = pos.nextLot - 2; // lot just below the one that filled
            let lotStop = breakeven;
            if (prevLotIdx >= 0) {
              lotStop = isLong
                ? +(pos.originalEntry * (1 + LOT_OFFSETS[prevLotIdx])).toFixed(2)
                : +(pos.originalEntry * (1 - LOT_OFFSETS[prevLotIdx])).toFixed(2);
            }
            const newStop = isLong
              ? Math.max(pos.stop, lotStop, breakeven)
              : Math.min(pos.stop, lotStop, breakeven);
            if (newStop !== pos.stop) {
              pos.stop = newStop;
              await enqueueAmbushOrder(db, 'MODIFY_STOP', {
                ticker: pos.ticker, direction: pos.direction,
                newStopPrice: pos.stop, shares: pos.totalShares, reason: 'LOT_TRAIL',
              });
            }
          }

          actions.push({
            type: 'LOT_FILL', ticker: pos.ticker,
            lot: pos.nextLot - 1, shares: lotShares, price: fillPrice,
          });
          await enqueueAmbushOrder(db, 'PLACE_LOT_TRIGGER', {
            ticker: pos.ticker, direction: pos.direction,
            lot: pos.nextLot - 1, shares: lotShares, triggerPrice: lotTrigger,
          });
        }
      }

      // Check B: 2-bar broken-low / broken-high exit (post-Break-Even only).
      // Two completed bars made a lower low (long) / higher high (short); this bar takes
      // out that low/high by $0.01. Exit there IF it is better than the hard stop.
      if (!exited && pos.atBE && pos.prevSyntheticBar) {
        if (isLong && pos.prevBarLow != null && pos.prevSyntheticBar.low < pos.prevBarLow) {
          const breakLevel = +(pos.prevSyntheticBar.low - 0.01).toFixed(2);
          if (breakLevel > pos.stop && price <= breakLevel) {
            await doLiveExit(breakLevel, 'TRAILING_STOP', 'TRAILING_EXIT');
          }
        } else if (!isLong && pos.prevBarHigh != null && pos.prevSyntheticBar.high > pos.prevBarHigh) {
          const breakLevel = +(pos.prevSyntheticBar.high + 0.01).toFixed(2);
          if (breakLevel < pos.stop && price >= breakLevel) {
            await doLiveExit(breakLevel, 'TRAILING_STOP', 'TRAILING_EXIT');
          }
        }
      }

      // Check C: Hard stop (pre-BE = first-hour stop; post-BE = lot/breakeven stop).
      if (!exited && pos.stop != null) {
        if (isLong && price <= pos.stop) {
          await doLiveExit(pos.stop, pos.atBE ? 'LOT_STOP' : '1H_LOW_BREAK', pos.atBE ? 'LOT_EXIT' : '1H_EXIT');
        } else if (!isLong && price >= pos.stop) {
          await doLiveExit(pos.stop, pos.atBE ? 'LOT_STOP' : '1H_HIGH_BREAK', pos.atBE ? 'LOT_EXIT' : '1H_EXIT');
        }
      }

      // Check D: Break Even ($75 unrealized -> stop to breakeven, PROTECT).
      if (!exited) {
        const unr = isLong
          ? (price - pos.avgCost) * pos.totalShares
          : (pos.avgCost - price) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        if (!pos.atBE && unr >= BE_THRESHOLD) {
          pos.atBE = true;
          pos.beDate = today;
          const feePer = calcCommission(pos.totalShares, pos.avgCost) / pos.totalShares;
          pos.stop = isLong
            ? +(pos.avgCost + feePer).toFixed(2)
            : +(pos.avgCost - feePer).toFixed(2);
          pos.state = STATES.PROTECT;

          actions.push({ type: 'BREAK_EVEN', ticker: pos.ticker, stop: pos.stop });
          await enqueueAmbushOrder(db, 'MODIFY_STOP', {
            ticker: pos.ticker, direction: pos.direction,
            newStopPrice: pos.stop, shares: pos.totalShares, reason: 'BREAK_EVEN',
          });
        }
      }

      // Save position state if still open.
      if (!exited) {
        await upsertAmbushPosition(db, pos.ticker, {
          state: pos.atBE ? STATES.PROTECT : STATES.ACTIVE,
          stop: pos.stop,
          avgCost: pos.avgCost,
          totalShares: pos.totalShares,
          nextLot: pos.nextLot,
          atBE: pos.atBE,
          trailingActive: false,
          beDate: pos.beDate,
          peak: pos.peak,
          prevBarLow: pos.prevBarLow,
          prevBarHigh: pos.prevBarHigh,
          todayFirstHourLow: pos.todayFirstHourLow,
          todayFirstHourHigh: pos.todayFirstHourHigh,
          todayDate: pos.todayDate,
          syntheticBar: pos.syntheticBar,
          prevSyntheticBar: pos.prevSyntheticBar,
          lastBarDate: pos.syntheticBar?.hourKey || pos.lastBarDate,
          livePrice: price,
          livePriceAt: now,
        });
      }

    } catch (err) {
      errors.push({ ticker: pos.ticker, error: err.message });
      console.error(`[Ambush] Error processing ${pos.ticker}:`, err.message);
    }
  }

  // ═══ PHASE B: Process ATTACK positions (execute pending re-entries) ═══
  // During first hour, skip re-entries (need first-hour data first).
  if (!isFirstHour) {
    const attackPositions = allPositions.filter(p => p.state === STATES.ATTACK);

    for (const pend of attackPositions) {
      try {
        const price = livePrices[pend.ticker];
        if (!price) continue;

        // Count ACTIVE/PROTECT from already-loaded positions + actions taken this tick
        const newEntriesThisTick = actions.filter(a => a.type === 'NEW_ENTRY' || a.type === 'RE_ENTRY').length;
        const exitsThisTick = actions.filter(a => a.type === '1H_EXIT' || a.type === 'TRAILING_EXIT').length;
        const baseActive = allPositions.filter(p =>
          p.state === STATES.ACTIVE || p.state === STATES.PROTECT
        ).length;
        const activeCount = baseActive + newEntriesThisTick - exitsThisTick;
        if (activeCount >= maxPositions) {
          actions.push({ type: 'SKIPPED_CAP', ticker: pend.ticker });
          continue;
        }

        const isLong = pend.direction === 'LONG';

        // Enter at current live price (with slippage)
        const rePrice = isLong
          ? entrySlip(price, 'LONG')
          : entrySlip(price, 'SHORT');
        const reStop = isLong
          ? +((pend.runningLow || price * 0.97) - 0.01).toFixed(2)
          : +((pend.runningHigh || price * 1.03) + 0.01).toFixed(2);

        if (isLong && reStop >= rePrice) { await deleteAmbushPosition(db, pend.ticker); continue; }
        if (!isLong && reStop <= rePrice) { await deleteAmbushPosition(db, pend.ticker); continue; }

        const sizing = sizeLots(rePrice, reStop, pend.direction, tradingNav, sizeMult);
        if (!sizing) { await deleteAmbushPosition(db, pend.ticker); continue; }

        // V7.3 cash gate: skip if we can't fund Lot 1 (keep the ATTACK row for next tick).
        const reL1Cost = sizing.l1Shares * rePrice;
        if (reL1Cost > availableCash) {
          actions.push({ type: 'SKIPPED_CASH', ticker: pend.ticker });
          continue;
        }
        availableCash -= reL1Cost;

        // Transition ATTACK -> ACTIVE
        await upsertAmbushPosition(db, pend.ticker, {
          state: STATES.ACTIVE,
          direction: pend.direction,
          entryPrice: rePrice,
          avgCost: rePrice,
          totalShares: sizing.l1Shares,
          lotPlan: sizing.lotPlan,
          nextLot: 1,
          originalEntry: pend.originalEntry || rePrice,
          stop: reStop,
          atBE: false,
          trailingActive: false,
          beDate: null,
          peak: 0,
          cycleNum: pend.cycleNum || 0,
          entryDate: today,
          runningLow: pend.runningLow,
          runningHigh: pend.runningHigh,
          consecutiveLowerLows: 0,
          prevBarLow: null,
          prevBarHigh: null,
          todayFirstHourLow: pend.todayFirstHourLow,
          todayFirstHourHigh: pend.todayFirstHourHigh,
          todayDate: today,
          syntheticBar: null,
          prevSyntheticBar: null,
          lastBarDate: hourKey,
          livePrice: price,
          livePriceAt: now,
        });

        await enqueueAmbushOrder(db, isLong ? 'BUY_ENTRY' : 'SHORT_ENTRY', {
          ticker: pend.ticker, shares: sizing.l1Shares, price: rePrice,
          direction: pend.direction, stopPrice: reStop,
          lotPlan: sizing.lotPlan, rps: sizing.rps,
        });

        actions.push({
          type: 'RE_ENTRY', ticker: pend.ticker, direction: pend.direction,
          shares: sizing.l1Shares, price: rePrice, stop: reStop,
          cycle: pend.cycleNum, sizingTier: sizeTier,
        });
      } catch (err) {
        errors.push({ ticker: pend.ticker, error: err.message });
      }
    }
  }

  // ═══ PHASE C: Process STALKING positions (breakout detection) ═══
  // Uses synthetic bars built from live prices.
  // During first hour, skip breakout detection.
  if (!isFirstHour) {
    const stalkingPositions = allPositions.filter(p => p.state === STATES.STALKING);

    for (const stalk of stalkingPositions) {
      try {
        const price = livePrices[stalk.ticker];
        if (!price) continue;

        const isLong = stalk.direction === 'LONG';

        // Check if weekly signal is still active
        if (isLong && !isActiveBL(ctx, stalk.ticker, today)) {
          await deleteAmbushPosition(db, stalk.ticker);
          actions.push({ type: 'SIGNAL_EXPIRED', ticker: stalk.ticker });
          continue;
        }
        if (!isLong && !isActiveSS(ctx, stalk.ticker, today)) {
          await deleteAmbushPosition(db, stalk.ticker);
          actions.push({ type: 'SIGNAL_EXPIRED', ticker: stalk.ticker });
          continue;
        }

        // Check regime + sector
        const regime = getRegime(ctx, stalk.ticker, today);
        if (isLong && !regime) continue;
        if (!isLong && regime) continue;
        if (!getSectorOk(ctx, stalk.ticker, today)) continue;

        // Update running low/high from live price
        if (price < (stalk.runningLow || Infinity)) stalk.runningLow = price;
        if (price > (stalk.runningHigh || -Infinity)) stalk.runningHigh = price;

        // Need at least prevSyntheticBar + current syntheticBar for breakout check
        if (!stalk.prevSyntheticBar || !stalk.syntheticBar) {
          // Save updated tracking data
          await upsertAmbushPosition(db, stalk.ticker, {
            runningLow: stalk.runningLow,
            runningHigh: stalk.runningHigh,
            syntheticBar: stalk.syntheticBar,
            prevSyntheticBar: stalk.prevSyntheticBar,
            todayFirstHourLow: stalk.todayFirstHourLow,
            todayFirstHourHigh: stalk.todayFirstHourHigh,
            todayDate: stalk.todayDate,
            livePrice: price,
            livePriceAt: now,
          });
          continue;
        }

        // Check for confirmed breakout using synthetic bars.
        // IMPORTANT: Only evaluate breakout on the FIRST tick after hour rollover
        // (when prevSyntheticBar just finalized). Evaluating mid-bar would cause
        // false positives because the in-progress bar's close changes every 60s.
        const bar = stalk.syntheticBar;      // current in-progress bar
        const prevBar = stalk.prevSyntheticBar; // last completed bar

        // Skip breakout check if we already checked this hour (avoid re-firing)
        if (stalk._lastBreakoutCheckHour === bar.hourKey) {
          await upsertAmbushPosition(db, stalk.ticker, {
            runningLow: stalk.runningLow, runningHigh: stalk.runningHigh,
            syntheticBar: stalk.syntheticBar, prevSyntheticBar: stalk.prevSyntheticBar,
            todayFirstHourLow: stalk.todayFirstHourLow, todayFirstHourHigh: stalk.todayFirstHourHigh,
            todayDate: stalk.todayDate, livePrice: price, livePriceAt: now,
          });
          continue;
        }

        // Use the completed prevBar as "current" for breakout pattern check,
        // and the bar before that (stored as prevBarLow/High) as the reference.
        // This ensures we're evaluating fully-formed bars, not mid-hour noise.
        const checkBar = prevBar;  // last completed bar
        const refBar = (stalk.prevBarLow != null && stalk.prevBarHigh != null)
          ? { low: stalk.prevBarLow, high: stalk.prevBarHigh, open: stalk.prevBarLow, close: stalk.prevBarHigh }
          : null;

        const breakoutDetected = refBar
          ? (isLong
              ? isConfirmedGreenBreakout(checkBar, refBar)
              : isConfirmedRedBreakdown(checkBar, refBar))
          : false;

        if (breakoutDetected) {
          // Transition STALKING -> ATTACK (queue entry for next tick)
          await upsertAmbushPosition(db, stalk.ticker, {
            state: STATES.ATTACK,
            direction: stalk.direction,
            originalEntry: stalk.originalEntry,
            runningLow: stalk.runningLow || bar.low,
            runningHigh: stalk.runningHigh || bar.high,
            cycleNum: stalk.cycleNum || 0,
            todayFirstHourLow: stalk.todayFirstHourLow,
            todayFirstHourHigh: stalk.todayFirstHourHigh,
            todayDate: today,
            syntheticBar: null,
            prevSyntheticBar: null,
            prevBarLow: prevBar.low,
            prevBarHigh: prevBar.high,
            _lastBreakoutCheckHour: bar.hourKey,
            livePrice: price,
            livePriceAt: now,
          });

          actions.push({
            type: 'BREAKOUT_DETECTED', ticker: stalk.ticker,
            direction: stalk.direction, price,
          });
        } else {
          // Save updated tracking data + mark this hour as checked
          await upsertAmbushPosition(db, stalk.ticker, {
            runningLow: stalk.runningLow,
            runningHigh: stalk.runningHigh,
            syntheticBar: stalk.syntheticBar,
            prevSyntheticBar: stalk.prevSyntheticBar,
            prevBarLow: prevBar.low,
            prevBarHigh: prevBar.high,
            todayFirstHourLow: stalk.todayFirstHourLow,
            todayFirstHourHigh: stalk.todayFirstHourHigh,
            todayDate: stalk.todayDate,
            _lastBreakoutCheckHour: bar.hourKey,
            livePrice: price,
            livePriceAt: now,
          });
        }
      } catch (err) {
        errors.push({ ticker: stalk.ticker, error: err.message });
      }
    }
  }

  // ═══ PHASE D: New MCE entries (fresh signals entering the pipeline) ═══
  // Pre-filters use live prices + cached daily bars (fast, no FMP hourly).
  // Final breakout confirmation uses FMP hourly bars for the narrow candidate set.
  // During first hour, skip MCE scanning entirely.
  if (!isFirstHour && mceCandidates.length > 0) {
    // Step 1: Pre-filter — regime + sector + signal + 2-day trigger
    const priorDayData = await fetchPriorDayData(mceCandidates, today);
    const breakoutCandidates = [];

    for (const ticker of mceCandidates) {
      const price = livePrices[ticker];
      if (!price) continue;

      const regime = getRegime(ctx, ticker, today);
      if (!getSectorOk(ctx, ticker, today)) continue;

      let direction = null;
      if (regime && isActiveBL(ctx, ticker, today)) direction = 'LONG';
      else if (!regime && isActiveSS(ctx, ticker, today)) direction = 'SHORT';
      if (!direction) continue;

      // 2-day trigger check using cached daily bars
      const priorData = priorDayData[ticker];
      if (!priorData || priorData.highs.length === 0) continue;

      if (direction === 'LONG') {
        const trigger = Math.max(...priorData.highs) + 0.01;
        if (price < trigger) continue; // today's price hasn't broken above trigger
      } else {
        const trigger = Math.min(...priorData.lows) - 0.01;
        if (price > trigger) continue; // today's price hasn't broken below trigger
      }

      breakoutCandidates.push({ ticker, direction });
    }

    // Step 2: For the narrow candidate set, fetch FMP hourly bars for breakout check
    if (breakoutCandidates.length > 0) {
      console.log(`[Ambush] MCE: ${breakoutCandidates.length} tickers passed pre-filter, checking hourly breakout...`);
      const candidateTickers = breakoutCandidates.map(c => c.ticker);
      const hourlyBars = await fetchFmpHourlyBars(candidateTickers);

      for (const { ticker, direction } of breakoutCandidates) {
        try {
          const hBars = hourlyBars[ticker];
          if (!hBars || hBars.length < 2) continue;

          const todayOnlyBars = hBars.filter(b => b.date.startsWith(today));
          if (todayOnlyBars.length < 2) continue;

          // Hourly confirmed breakout
          const afterFirst = todayOnlyBars.filter(b => extractTime(b.date) >= FIRST_HOUR_END);
          if (afterFirst.length < 2) continue;

          let breakoutFound = false;
          for (let i = 1; i < afterFirst.length; i++) {
            const bar = afterFirst[i], prevBar = afterFirst[i - 1];
            if (direction === 'LONG' && isConfirmedGreenBreakout(bar, prevBar)) {
              breakoutFound = true;
              break;
            }
            if (direction === 'SHORT' && isConfirmedRedBreakdown(bar, prevBar)) {
              breakoutFound = true;
              break;
            }
          }

          if (!breakoutFound) continue;

          // Calculate entry price using LIVE price (not stale bar open)
          const currentPrice = livePrices[ticker];
          if (!currentPrice) continue;
          const ep = direction === 'LONG'
            ? entrySlip(currentPrice, 'LONG')
            : entrySlip(currentPrice, 'SHORT');

          // 1H Stop: firstHourLow - fees (LONG) / firstHourHigh + fees (SHORT)
          const firstHourBars = todayOnlyBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
          let stop;
          if (direction === 'LONG') {
            const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
            if (!firstHourLow || firstHourLow >= ep) continue;
            stop = +(firstHourLow - COMMISSION_PER_SHARE).toFixed(2);
          } else {
            const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;
            if (!firstHourHigh || firstHourHigh <= ep) continue;
            stop = +(firstHourHigh + COMMISSION_PER_SHARE).toFixed(2);
          }
          if (direction === 'LONG' && stop >= ep) continue;
          if (direction === 'SHORT' && stop <= ep) continue;

          const sizing = sizeLots(ep, stop, direction, tradingNav, sizeMult);
          if (!sizing) continue;

          // V7.3 cash gate: skip new entry if we can't fund Lot 1.
          const mceL1Cost = sizing.l1Shares * ep;
          if (mceL1Cost > availableCash) {
            actions.push({ type: 'SKIPPED_CASH', ticker });
            continue;
          }
          availableCash -= mceL1Cost;

          // Check position count (from already-loaded positions + this tick's actions)
          const mceNewEntries = actions.filter(a => a.type === 'NEW_ENTRY' || a.type === 'RE_ENTRY').length;
          const mceExits = actions.filter(a => a.type === '1H_EXIT' || a.type === 'TRAILING_EXIT').length;
          const mceBaseActive = allPositions.filter(p =>
            p.state === STATES.ACTIVE || p.state === STATES.PROTECT
          ).length;
          const currentActive = mceBaseActive + mceNewEntries - mceExits;
          if (currentActive >= maxPositions) continue;

          // Create new ACTIVE position
          const todayHigh = Math.max(...todayOnlyBars.map(b => b.high));
          const todayLow = Math.min(...todayOnlyBars.map(b => b.low));

          await upsertAmbushPosition(db, ticker, {
            state: STATES.ACTIVE,
            direction,
            entryPrice: ep,
            avgCost: ep,
            totalShares: sizing.l1Shares,
            lotPlan: sizing.lotPlan,
            nextLot: 1,
            originalEntry: ep,
            stop,
            atBE: false,
            trailingActive: false,
            beDate: null,
            peak: 0,
            cycleNum: 0,
            entryDate: today,
            runningLow: todayLow,
            runningHigh: todayHigh,
            consecutiveLowerLows: 0,
            prevBarLow: null,
            prevBarHigh: null,
            todayFirstHourLow: firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null,
            todayFirstHourHigh: firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null,
            todayDate: today,
            syntheticBar: null,
            prevSyntheticBar: null,
            lastBarDate: todayOnlyBars[todayOnlyBars.length - 1].date,
            livePrice: livePrices[ticker] || ep,
            livePriceAt: now,
          });

          await enqueueAmbushOrder(db, direction === 'LONG' ? 'BUY_ENTRY' : 'SHORT_ENTRY', {
            ticker, shares: sizing.l1Shares, price: ep,
            direction, stopPrice: stop,
            lotPlan: sizing.lotPlan, rps: sizing.rps,
          });

          actions.push({
            type: 'NEW_ENTRY', ticker, direction,
            shares: sizing.l1Shares, price: ep, stop,
            sizingTier: sizeTier,
          });
        } catch (err) {
          errors.push({ ticker, error: err.message });
        }
      }
    }
  }

  // ═══ Update config with last run info ═══
  const result = {
    date: today,
    time: et.timeStr,
    nav,
    tradingNav,
    withdrawalAlert,
    navSource,
    sizingTier: sizeTier,
    sizingMultiplier: sizeMult,
    priceSource: 'IBKR+FMP',
    tickersPriced: Object.keys(livePrices).length,
    actions,
    errors,
    positions: {
      active: activePositions.length,
      attack: allPositions.filter(p => p.state === STATES.ATTACK).length,
      stalking: allPositions.filter(p => p.state === STATES.STALKING).length,
    },
    isFirstHour,
  };

  // Daily actual-AUM snapshot for the Projected vs Actual tracker (end-of-day = last tick).
  await recordAmbushAum(db, today, nav);

  await updateAmbushConfig(db, {
    lastCronRun: now,
    lastCronResult: result,
  });

  if (actions.length > 0) {
    console.log(`[Ambush] Tick complete - ${actions.length} actions: ${actions.map(a => `${a.type}:${a.ticker}`).join(', ')}`);
  }
  return result;
}
