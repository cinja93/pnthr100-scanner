// server/ambush/ambushCron.js
// ── PNTHR AMBUSH V7.4 — 60-Second Live Tick Processor ─────────────────────
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
  entrySlip, exitSlip, extractTime, sizeLots,
  getSizingMultiplier, getSizingTierLabel,
  loadSignalContext, getRegime, getSectorOk, isActiveBL, isActiveSS, getWeeklyTrigger,
  getAiTickers, getSectorName,
} from './ambushEngine.js';
import { calcCommission, calcBorrowCost } from '../backtest/costEngine.js';
import {
  getAmbushPositions, getAmbushPosition, upsertAmbushPosition,
  deleteAmbushPosition, logAmbushTrade, enqueueAmbushOrder,
  getAmbushConfig, updateAmbushConfig, recordAmbushAum,
} from './ambushStateManager.js';

const FMP_API_KEY = process.env.FMP_API_KEY;

// ── PNTHR AMBUSH V7.4 RULE FLAGS (locked 2026-06-01) ─────────────────────────
// Two changes from V7.3, both validated by the full backtest
// (server/backtest/pai300HourlyV74.js — "no-gate + 2-bar" = +54.8% total value,
//  DD 2.17%->1.28%, shorts +$4.0M, deployed <=1x gross, edge persists every year).
//   1. REGIME GATE REMOVED: take BL+1 longs AND SS+1 shorts in ANY PAI300 regime
//      (V7.3 took longs only in a bull index, shorts only in a bear index).
//   2. $75 BREAK-EVEN SNAP REMOVED: the 2-bar broken-low governs the exit from
//      entry; the first-hour low stays the disaster floor; the lot-trail ratchets
//      from entry. (V7.3 parked the stop at breakeven once +$75 unrealized.)
// Flip both back to true to restore exact V7.3 behavior.
const AMBUSH_REGIME_GATE = false;
const AMBUSH_BE75_SNAP   = false;

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

// ── Data Source: Prior-Day Data (per-day incremental cache, for the 2-day trigger) ──
// Fetches last 5 daily bars per ticker from FMP. Returns { ticker: { highs, lows } }
// for the requested tickers. The cache is per-DAY but INCREMENTAL: it keeps every
// ticker fetched today and only fetches the ones it doesn't yet have. The old cache
// was all-or-nothing — it returned the FIRST caller's ticker set to every later caller,
// so when re-entry (Phase C) and new-entry (Phase D) ask for different tickers, the
// later one was starved. Failed fetches are NOT cached, so a transient FMP error retries
// next tick (we never want to miss a re-entry/entry because of one bad fetch).

let _priorDayCache = { date: null, data: {} };

async function fetchPriorDayData(tickers, today) {
  if (_priorDayCache.date !== today) _priorDayCache = { date: today, data: {} };
  const missing = [...new Set(tickers)].filter(t => t && !(t in _priorDayCache.data));
  if (missing.length) {
    console.log(`[Ambush] Fetching prior-day data for ${missing.length} ticker(s)...`);
    const batchSize = 5;
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
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
            _priorDayCache.data[ticker] = { highs: lastTwo.map(b => +b.high), lows: lastTwo.map(b => +b.low) };
          }
          // no data → leave uncached so it retries next tick
        }
      }
    }
  }
  const out = {};
  for (const t of tickers) if (_priorDayCache.data[t]) out[t] = _priorDayCache.data[t];
  return out;
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

// Fetch FMP 30-MINUTE bars (used to rebuild :00 clock-hour bars that match the trader's
// TWS chart). Same shape/batching as fetchFmpHourlyBars. Timestamps are ET.
async function fetchFmp30MinBars(tickers) {
  const barMap = {};
  if (!tickers.length || !FMP_API_KEY) return barMap;
  const batchSize = 5;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        try {
          const url = `https://financialmodelingprep.com/api/v3/historical-chart/30min/${ticker}?apikey=${FMP_API_KEY}`;
          const resp = await fetch(url);
          if (!resp.ok) return { ticker, bars: [] };
          const data = await resp.json();
          const bars = (Array.isArray(data) ? data : []).map(b => ({
            date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close,
          }));
          return { ticker, bars };
        } catch {
          return { ticker, bars: [] };
        }
      })
    );
    for (const r of results) if (r.status === 'fulfilled' && r.value) barMap[r.value.ticker] = r.value.bars;
  }
  return barMap;
}

// Aggregate FMP 30-minute bars into :00 CLOCK-HOUR bars — the exact bars the trader's TWS
// chart shows (IBKR clock bars: 10:00-11:00, 11:00-12:00, ...). FMP 1h bars are 9:30-aligned
// (:30), which puts intra-hour lows in the wrong bucket and mis-sizes the 2-bar stop (NXPI
// :30 low 319.97 vs the correct :00 low 322.62). Returns COMPLETED clock-hour bars only —
// a clock hour is complete once its end (hr+1:00) has passed (the forming hour is dropped).
function clockHourBars(min30, today, nowTotalMin) {
  const byHour = {};
  for (const b of (min30 || [])) {
    if (!b.date.startsWith(today)) continue;
    const hr = parseInt(extractTime(b.date).slice(0, 2), 10); // ET start hour
    (byHour[hr] = byHour[hr] || []).push(b);
  }
  const out = [];
  for (const hr of Object.keys(byHour).map(Number).sort((a, b) => a - b)) {
    if ((hr + 1) * 60 > nowTotalMin) continue; // hour not finished yet — drop the forming bar
    const bs = byHour[hr].sort((a, b) => a.date.localeCompare(b.date));
    out.push({
      hourKey: `${today} ${String(hr).padStart(2, '0')}:00:00`,
      open: +bs[0].open,
      high: Math.max(...bs.map(x => +x.high)),
      low: Math.min(...bs.map(x => +x.low)),
      close: +bs[bs.length - 1].close,
    });
  }
  return out; // chronological, completed clock-hour bars
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

// ── Weekly + Daily TRIGGER levels (2026-06-03, Scott's re-entry rule) ────────
// The DAILY trigger = the higher of the last 2 completed daily bars' highs + $0.01
// (long) / the lower of the last 2 lows − $0.01 (short) — the breakout level. The
// WEEKLY trigger = the breakout entry of the active weekly BL/SS (from the signal).
// Both are FROZEN for the life of the weekly signal cycle; a name is re-entry eligible
// only while the current price holds above BOTH (long) / below BOTH (short).
function rolling2Day(pd, isLong) {
  if (!pd || !Array.isArray(pd.highs) || !pd.highs.length) return null;
  return isLong
    ? +(Math.max(...pd.highs) + 0.01).toFixed(2)
    : +(Math.min(...pd.lows) - 0.01).toFixed(2);
}

// Freeze/refresh the triggers on a position (mutates pos). `rolling` = today's 2-day
// breakout level; `price` = live price. New weekly cycle (the active signal's start
// week changed) → recapture: clear the frozen daily trigger + reset the weekly trigger.
// Freeze the daily trigger the FIRST time the breakout fires this cycle (the ORIGINAL
// price that caused the trigger), then hold it. Returns true if any value changed.
function applyTriggerMaintenance(pos, ctx, today, rolling, price) {
  const isLong = pos.direction === 'LONG';
  // Only use a weekly trigger whose SIGNAL DIRECTION matches the position. An adopted
  // position can be SHORT while the weekly signal is BL (long) — that long trigger must
  // NOT attach to a short (it would gate the wrong way). No matching-direction signal →
  // no weekly trigger (such a name also fails the isActiveBL/SS re-entry check anyway).
  const wtRaw = getWeeklyTrigger(ctx, pos.ticker, today);
  const wt = (wtRaw && wtRaw.dir === pos.direction) ? wtRaw : null;
  const wtFrom = wt?.from ?? null;
  let changed = false;
  if ((pos.weeklyTriggerFrom ?? null) !== wtFrom) {
    // new weekly signal cycle (or the signal ended) → recapture this cycle's triggers
    if (pos.dailyTrigger != null) { pos.dailyTrigger = null; changed = true; }
    pos.weeklyTriggerFrom = wtFrom;
    pos.weeklyTrigger = wt?.level ?? null;
    changed = true;
  } else if (pos.weeklyTrigger == null && wt?.level != null) {
    pos.weeklyTrigger = wt.level; changed = true;
  }
  // Freeze the daily trigger. A HELD position has ALREADY broken out, so record the
  // breakout level now regardless of where price sits (a pulled-back winner must still
  // show its trigger). A FLAT/STALKING name freezes it only when the breakout actually
  // fires (price on the breakout side) — that's the re-entry trigger forming. For a
  // brand-new entry this captures the entry-day 2-day high (= the original trigger); for
  // a position already open before this feature, it's a best-effort current 2-day high.
  if (pos.dailyTrigger == null && rolling != null) {
    const held = (+pos.totalShares || 0) !== 0;
    const breakingOut = typeof price === 'number' && (isLong ? price >= rolling : price <= rolling);
    if (held || breakingOut) { pos.dailyTrigger = rolling; changed = true; }
  }
  return changed;
}

// ── Main Cron Tick ──────────────────────────────────────────────────────────

let _tickRunning = false;

// Cross-instance lock: only ONE engine (across ALL server instances) can process a
// given tick, so a rolling deploy / autoscale / stray server can never double-process
// the same positions and double real orders. Classic MongoDB lock on a fixed _id.
async function _acquireTickLock(db) {
  try {
    await db.collection('pnthr_ambush_lock').findOneAndUpdate(
      { _id: 'tick', lockedUntil: { $lt: new Date() } },
      { $set: { lockedUntil: new Date(Date.now() + 55000), at: new Date() } },
      { upsert: true }
    );
    return true; // acquired (inserted or refreshed an expired lock)
  } catch (e) {
    if (e && e.code === 11000) return false; // another instance holds the lock
    throw e;
  }
}
// No explicit release: the 55s lease (< the 60s cron interval) holds the lock for the
// rest of the minute so no second instance can sneak a same-minute run, then expires
// on its own before the next tick. Self-healing if a holder dies mid-tick.

export async function runAmbushTick() {
  if (_tickRunning) {
    console.warn('[Ambush] Tick already in progress — skipping');
    return { skipped: 'ALREADY_RUNNING' };
  }
  _tickRunning = true;
  let lockDb = null;
  try {
    lockDb = await connectToDatabase();
    if (lockDb) {
      const got = await _acquireTickLock(lockDb);
      if (!got) { return { skipped: 'LOCKED_BY_OTHER_INSTANCE' }; }
    }
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
  // Entry windows (Scott 2026-06-04): take NEW entries right up to the 4:00 close bell —
  // late-day institutional momentum often carries overnight, and the V7.4 backtest has NO
  // close cutoff, so live must match it. Block entries ONLY:
  //   • OPEN blackout 9:25-9:35 (inside the first hour anyway), and
  //   • AFTER the bell, 16:00-16:05 — a regular market order then can't fill in RTH (it
  //     would just FILLING-revert), so there's no point firing it.
  // A late entry that doesn't fill is handled cleanly by the FILLING flow (reverts, no
  // phantom). Existing positions are managed (stops/exits) right through the close regardless.
  const inEntryBlackout = (et.totalMinutes >= 565 && et.totalMinutes <= 575)
                       || (et.totalMinutes >= 960 && et.totalMinutes <= 965);

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
      message: `Account hit $${nav.toLocaleString()} — withdraw $${WITHDRAWAL_AMOUNT.toLocaleString()} and trade off $${tradingNav.toLocaleString()} (V7.4 rule).`,
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
  const actions = [];
  const errors = [];

  // ── RECONCILE-BEFORE-ACT data (2026-06-03 incident) ──────────────────────────
  // Load the live IBKR share count (signed) per ticker from the bridge snapshot.
  // The engine must NEVER exit on its own `totalShares` alone — a manual trade or a
  // missed fill can leave it tracking a position IBKR no longer holds, and a
  // SELL/COVER then OPENS the opposite side (the AVGO short). doLiveExit consults
  // this map before placing any exit. See AUDIT_PROTOCOL.md.
  const ibkrSharesByTicker = {};
  const ibkrAvgByTicker = {};
  const ibkrStopSidesByTicker = {}; // ticker -> Set of protective stop actions present in IBKR ('SELL'/'BUY')
  let ibkrSnapAgeMin = Infinity;
  try {
    const snap = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: config.ownerId });
    if (snap?.positions) for (const p of snap.positions) {
      const t = (p.symbol || p.ticker || '').toUpperCase();
      if (t) { ibkrSharesByTicker[t] = +p.shares || 0; ibkrAvgByTicker[t] = +p.avgCost || +p.marketPrice || 0; }
    }
    // Index the live IBKR protective stops so Check B can VERIFY a stop actually exists
    // (the record's pos.stop is only the engine's INTENT — it diverges when a stop was
    // never placed, e.g. an adopted position, or a manual cancel). A protective stop is
    // a STP/STP LMT on the exit side (SELL for a long, BUY for a short).
    if (snap?.stopOrders) for (const s of snap.stopOrders) {
      const t = (s.symbol || '').toUpperCase();
      if (t && (s.orderType === 'STP' || s.orderType === 'STP LMT') && s.action) {
        (ibkrStopSidesByTicker[t] = ibkrStopSidesByTicker[t] || new Set()).add(s.action);
      }
    }
    if (snap?.syncedAt) ibkrSnapAgeMin = (Date.now() - new Date(snap.syncedAt).getTime()) / 60000;
  } catch (e) {
    console.warn(`[Ambush] reconcile guard: could not load IBKR snapshot (${e.message}) — exits will use engine share count`);
  }

  // ── 2b. CONFIRM FILLING ENTRIES (2026-06-03 root-cause fix) ──────────────────
  // An entry is FILLING until IBKR confirms the fill. This is the ROOT-CAUSE fix for
  // phantoms: the engine NEVER marks a position ACTIVE on its own optimism — only when
  // the broker actually holds it. A rejected entry (CLOSE_BLACKOUT, buying power, a
  // halt, a dropped order) therefore can NEVER become a phantom — it just stays FILLING
  // (totalShares 0, not a held position, not flagged on the banner) and reverts.
  //   • IBKR confirms the position (right side) → promote FILLING→ACTIVE with the real
  //     fill size/avg; the entry order already placed the protective stop, so it's
  //     protected the instant it fills.
  //   • IBKR still flat past the fill timeout → the order never filled (rejected/lost) →
  //     revert FILLING→STALKING so the name can re-arm. No phantom, no naked order.
  // Runs BEFORE auto-adopt so a promoted entry keeps its intended (first-hour) stop
  // rather than being re-adopted with a 2-bar stop. Needs a fresh snapshot to judge.
  const FILL_TIMEOUT_MIN = 3;
  if (ibkrSnapAgeMin <= 10) {
    for (const pos of allPositions) {
      if (pos.state !== STATES.FILLING) continue;
      const ibSh = ibkrSharesByTicker[pos.ticker];
      const wantSign = pos.direction === 'LONG' ? 1 : -1;
      const confirmed = typeof ibSh === 'number' && ibSh !== 0 && Math.sign(ibSh) === wantSign;
      const ageMin = pos.orderEnqueuedAt ? (Date.now() - new Date(pos.orderEnqueuedAt).getTime()) / 60000 : Infinity;
      if (confirmed) {
        const filledShares = Math.abs(ibSh);
        const filledAvg = ibkrAvgByTicker[pos.ticker] || pos.avgCost;
        await upsertAmbushPosition(db, pos.ticker, {
          state: STATES.ACTIVE, pendingFill: false,
          totalShares: filledShares, avgCost: +(+filledAvg).toFixed(4),
          lotFills: [{ lot: 0, at: pos.orderEnqueuedAt || now, price: +(+filledAvg).toFixed(4) }],
          livePriceAt: now,
        });
        pos.state = STATES.ACTIVE; pos.totalShares = filledShares; pos.avgCost = +(+filledAvg).toFixed(4); pos.pendingFill = false;
        actions.push({ type: 'ENTRY_CONFIRMED', ticker: pos.ticker, direction: pos.direction, shares: filledShares });
        console.log(`[Ambush] ENTRY CONFIRMED ${pos.ticker} ${pos.direction} ${filledShares}sh @${filledAvg} — IBKR filled, FILLING->ACTIVE.`);
      } else if (ageMin > FILL_TIMEOUT_MIN) {
        await upsertAmbushPosition(db, pos.ticker, {
          state: STATES.STALKING, direction: pos.direction, originalEntry: pos.originalEntry,
          entryPrice: null, avgCost: null, totalShares: 0, lotPlan: null, nextLot: 0, stop: null, lotFills: null,
          atBE: false, trailingActive: false, beDate: null, peak: 0, pendingFill: false,
          prevBarLow: null, prevBarHigh: null, syntheticBar: null, prevSyntheticBar: null,
          cycleNum: (pos.cycleNum || 0) + 1, todayDate: today, livePriceAt: now,
          reconciledFlat: `ENTRY_UNFILLED_${today}`,
        });
        pos.state = STATES.STALKING; pos.totalShares = 0;
        actions.push({ type: 'ENTRY_UNFILLED', ticker: pos.ticker, direction: pos.direction });
        console.log(`[Ambush] ENTRY UNFILLED ${pos.ticker} ${pos.direction} — IBKR flat ${ageMin.toFixed(1)}m after order (rejected/never filled). Reverted to STALKING.`);
      }
      // else: still within the fill window, IBKR flat — keep FILLING, wait for the next snapshot.
    }
  }

  // ── 2c. AUTO-ADOPT every live IBKR position (2026-06-03) ─────────────────────
  // The engine manages EXACTLY what IBKR holds. For any live IBKR position NOT
  // already tracked as a held engine record on the SAME side, adopt it: create an
  // ACTIVE record matching IBKR (direction + size + avg) seeded with the current
  // 2-bar exit stop, so Phase A maintains its cover/exit stop. A real position can
  // NEVER sit unmanaged again — the ARCT/AKAM miss was the engine record saying
  // FLAT while IBKR held the position, so it placed no cover stop. The live IBKR
  // shares are the L1 base and the L2-L5 pyramid plan is built from the adopted
  // entry + 2-bar stop, exactly like a real entry (Scott 2026-06-03: manual/adopted
  // trades MUST pyramid like any other — the AVGO manual re-entry had no buy orders).
  // Needs a fresh snapshot + bars.
  if (ibkrSnapAgeMin <= 10) {
    try {
      const managed = new Set(
        allPositions
          .filter(p => (+p.totalShares || 0) !== 0 && p.state !== 'CLOSED')
          .map(p => `${(p.ticker || '').toUpperCase()}_${p.direction}`)
      );
      const barDocs = await db.collection('pnthr_ambush_hourly_bars').find({}).toArray();
      const barMap = {};
      for (const d of barDocs) barMap[(d.ticker || '').toUpperCase()] = d;
      for (const [t, sh] of Object.entries(ibkrSharesByTicker)) {
        if (!sh) continue;
        const dir = sh > 0 ? 'LONG' : 'SHORT';
        if (managed.has(`${t}_${dir}`)) continue; // engine already holds this side — skip
        const d = barMap[t];
        if (!d || !Array.isArray(d.bars) || d.bars.length < 3) continue; // need bars for the stop — retry next tick
        const ageM = d.syncedAt ? (Date.now() - new Date(d.syncedAt).getTime()) / 60000 : Infinity;
        if (ageM > 45) continue;
        const isLong = dir === 'LONG';
        // IBKR reqHistoricalData(keepUpToDate=false) returns COMPLETED bars only — no
        // partial in-progress bar. So the LAST bar (n-1) is the most-recent completed
        // hour and n-2 is the one before: the last-2-completed for the 2-bar stop.
        const n = d.bars.length, A = d.bars[n - 1], B = d.bars[n - 2];
        const stop = isLong ? +(Math.min(A.low, B.low) - 0.01).toFixed(2) : +(Math.max(A.high, B.high) + 0.01).toFixed(2);
        const entry = ibkrAvgByTicker[t] || +A.close;
        // Build the L2-L5 pyramid plan from the adopted entry + 2-bar stop, same as a
        // real entry; nextLot=2 means the live IBKR shares are L1 and Check A queues
        // L2+ as price runs. Mirrors the manual "Keep (adopt)" path in index.js.
        const sizing = sizeLots(entry, stop, dir, tradingNav, sizeMult);
        const adopted = {
          state: STATES.ACTIVE, direction: dir, totalShares: Math.abs(sh),
          avgCost: +entry.toFixed(4), entryPrice: +entry.toFixed(4), originalEntry: +entry.toFixed(4),
          stop, atBE: true, trailingActive: true, peak: 0,
          lotPlan: sizing?.lotPlan || null, nextLot: 2,
          prevSyntheticBar: { hourKey: String(A.date), open: +A.open, high: +A.high, low: +A.low, close: +A.close },
          prevBarLow: +B.low, prevBarHigh: +B.high,
          adoptedAt: now, adoptedFrom: 'AUTO_IBKR', todayDate: today, livePriceAt: now,
        };
        await upsertAmbushPosition(db, t, adopted);
        allPositions.push({ ticker: t, ...adopted });
        console.log(`[Ambush] AUTO-ADOPT ${t} ${dir} ${Math.abs(sh)}sh @${entry} — IBKR holds it, engine was not managing. 2-bar stop ${stop}; pyramid L2-L5 armed.`);
      }
    } catch (e) {
      console.warn(`[Ambush] auto-adopt skipped: ${e.message}`);
    }
  }

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

  // ── V7.3 "Watching": every active BL+1 (long) / SS+1 (short) name this week, with
  // regime + sector gate status. Computed every tick (incl. first hour) so the dashboard
  // shows the candidate pool the engine is hunting before any entry fires.
  const watchLongs = [], watchShorts = [];
  for (const ticker of getAiTickers()) {
    const bl = isActiveBL(ctx, ticker, today);
    const ss = isActiveSS(ctx, ticker, today);
    if (!bl && !ss) continue;
    const regime = getRegime(ctx, ticker, today);
    const sectorOk = getSectorOk(ctx, ticker, today);
    const tracked = existingTickers.has(ticker);
    const sector = getSectorName(ticker);
    // V7.4: regime no longer gates readiness (longs & shorts taken in any regime).
    const longRegimeOk  = AMBUSH_REGIME_GATE ? !!regime : true;
    const shortRegimeOk = AMBUSH_REGIME_GATE ? !regime  : true;
    if (bl) watchLongs.push({ ticker, sector, regimeOk: longRegimeOk, sectorOk, tracked, ready: longRegimeOk && sectorOk && !tracked });
    if (ss) watchShorts.push({ ticker, sector, regimeOk: shortRegimeOk, sectorOk, tracked, ready: shortRegimeOk && sectorOk && !tracked });
  }
  watchLongs.sort((a, b) => (b.ready - a.ready) || a.ticker.localeCompare(b.ticker));
  watchShorts.sort((a, b) => (b.ready - a.ready) || a.ticker.localeCompare(b.ticker));
  const watching = { longs: watchLongs, shorts: watchShorts };
  // HUNTING = candidates that have cleared their prior 2-day-high trigger today
  // (populated in Phase C). Read-only display field; does not affect any trade logic.
  let huntingList = [];

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

  // 5a. ── Seed last-2-completed bars from FRESH FMP :00 CLOCK-HOUR bars (2026-06-04) ──
  // PRIMARY source for the 2-bar TRAILING STOP on held positions. Two problems this fixes:
  //   (1) STALENESS — the per-ticker IBKR feed (pnthr_ambush_hourly_bars, 5b) lags badly
  //       (40-62 min on several names today), so the 2-bar level froze and the stop sat
  //       far too loose (EH 9.39 vs the true 9.25).
  //   (2) ALIGNMENT — FMP 1h bars are 9:30-aligned (:30), but the trader's TWS chart (and
  //       the IBKR feed) are :00 CLOCK bars. The :30 boundary puts an intra-hour low in the
  //       wrong bucket, mis-sizing the stop (NXPI :30 low 319.97 vs the correct :00 low
  //       322.62 the chart shows).
  // Fix: fetch FMP 30-min bars (fresh + uniform for ALL held names) and aggregate them into
  // :00 clock-hour bars that match the chart, then trail off the last two COMPLETED ones.
  // The stop ALWAYS adjusts to the current 2-bar low/high, never freezes, and matches TWS.
  const fmpSeeded = new Set();
  try {
    const heldForBars = allPositions.filter(p => (+p.totalShares || 0) !== 0);
    if (heldForBars.length) {
      const min30 = await fetchFmp30MinBars(heldForBars.map(p => p.ticker));
      for (const pos of heldForBars) {
        const t = (pos.ticker || '').toUpperCase();
        const hourBars = clockHourBars(min30[t], today, et.totalMinutes);
        if (hourBars.length < 2) continue; // not enough completed clock-hours — let the IBKR feed (5b) try
        const A = hourBars[hourBars.length - 1], B = hourBars[hourBars.length - 2];
        pos.prevSyntheticBar = { hourKey: A.hourKey, open: A.open, high: A.high, low: A.low, close: A.close };
        pos.prevBarLow  = B.low;
        pos.prevBarHigh = B.high;
        pos.atBE = true; // held position → 2-bar exit active so Check B maintains the stop
        fmpSeeded.add(t);
      }
      if (fmpSeeded.size) console.log(`[Ambush] seeded :00 clock-hour 2-bar levels (FMP 30m agg, matches TWS) for ${fmpSeeded.size} held positions`);
    }
  } catch (e) {
    console.warn(`[Ambush] FMP :00 2-bar seeding skipped (${e.message}) — falling back to IBKR feed`);
  }

  // 5b. ── Seed last-2-completed bars + exit level from the VERIFIED IBKR feed ──
  // (2026-06-03) The 2-bar-low exit (Check C, via Check B's level) and breakout
  // re-entry (Phase C) must use TRUE IBKR hourly bars — matching the trader's TWS
  // chart — NOT the live-sampled synthetic bars (which gap after a restart) or FMP
  // (whose 1h bars are :30-misaligned). The bridge posts IBKR :00 clock bars to
  // pnthr_ambush_hourly_bars; here we override each position's last-2-completed bars
  // and set the exit level to the CURRENT 2-bar-low — exactly the trader's stated
  // rule: exit when live price breaks (lowest low of the last two completed hourly
  // bars) − $0.01. Bars are chronological and the bridge ships COMPLETED bars ONLY
  // (it drops the still-forming current-hour bar), so the LAST element (n-1) is the
  // most-recent COMPLETED hour and n-2 is the one before it — together the last two
  // completed. (Do NOT revert to n-2/n-3: that was the off-by-one that left GFS/FN/
  // MKSI/EA stops a bar too far back.) Falls back to synthetic bars if the feed is
  // missing or stale (>45 min). Gated by AMBUSH_IBKR_BARS (default on).
  if (process.env.AMBUSH_IBKR_BARS !== 'false') {
    try {
      const barDocs = await db.collection('pnthr_ambush_hourly_bars').find({}).toArray();
      const barMap = {};
      for (const d of barDocs) barMap[(d.ticker || '').toUpperCase()] = d;
      let seeded = 0;
      for (const pos of allPositions) {
        if (fmpSeeded.has((pos.ticker || '').toUpperCase())) continue; // already seeded from FRESH FMP bars (5a) — don't overwrite with the laggy IBKR feed
        const d = barMap[(pos.ticker || '').toUpperCase()];
        if (!d || !Array.isArray(d.bars) || d.bars.length < 3) continue;
        const ageMin = d.syncedAt ? (Date.now() - new Date(d.syncedAt).getTime()) / 60000 : Infinity;
        if (ageMin > 45) continue; // stale feed (bridge sweep+cycle ~18m) — keep engine's own synthetic bars
        const n = d.bars.length;
        // CRITICAL (2026-06-03): IBKR reqHistoricalData(keepUpToDate=false) returns
        // COMPLETED bars ONLY — the feed has NO partial in-progress bar. So the LAST
        // bar (n-1) is the most-recent COMPLETED hour, and n-2 is the one before it:
        // together they are the last-2-completed the 2-bar exit must use. The old code
        // treated n-1 as "in-progress" and used n-2/n-3 ("3 bars ago"), so the trailing
        // stop never ratcheted up to the most recent completed bar's higher low —
        // GFS/FN/MKSI/EA sat one bar too far back and failed to fire at the true 2-bar low.
        const compA   = d.bars[n - 1];  // most recent COMPLETED hourly bar
        const compB   = d.bars[n - 2];  // the completed bar before it
        pos.prevSyntheticBar = { hourKey: String(compA.date), open: +compA.open, high: +compA.high, low: +compA.low, close: +compA.close };
        pos.prevBarLow  = +compB.low;
        pos.prevBarHigh = +compB.high;
        // NOTE: pos.stop is NOT set here. The exit block below (Check B) computes the
        // current 2-bar-low/high from these IBKR bars and places/updates the REAL resting
        // STP order in IBKR at that level (cancel+replace on every change, up or down).
        // For HELD positions, ensure the 2-bar exit is active (atBE) so Check B maintains
        // the resting stop from the first tick.
        if ((+pos.totalShares || 0) !== 0) pos.atBE = true;
        seeded++;
      }
      if (seeded) console.log(`[Ambush] seeded IBKR 2-bar levels for ${seeded} positions (true bars, matches TWS chart)`);
    } catch (e) {
      console.warn(`[Ambush] IBKR bar seeding skipped (${e.message}) — using engine synthetic bars`);
    }
  }

  // ── MAINTAIN WEEKLY + DAILY TRIGGERS (2026-06-03, Scott's re-entry rule) ──────
  // Freeze each tracked name's Weekly Trigger (the active signal's breakout entry) and
  // Daily Trigger (the original 2-day breakout level), refresh on a new weekly cycle,
  // and persist them so (a) the re-entry gate (Phase C) can require price to hold above
  // both, and (b) the Live Positions UI can show both columns. Stops on a held position
  // are unaffected — this only governs RE-ENTRY eligibility + the display.
  try {
    const trackedPriorData = await fetchPriorDayData(allPositions.map(p => p.ticker), today);
    for (const pos of allPositions) {
      if (pos.state === STATES.CLOSED) continue;
      const isLong = pos.direction === 'LONG';
      const rolling = rolling2Day(trackedPriorData[pos.ticker], isLong);
      const changed = applyTriggerMaintenance(pos, ctx, today, rolling, livePrices[pos.ticker] ?? null);
      if (changed) {
        await upsertAmbushPosition(db, pos.ticker, {
          weeklyTrigger: pos.weeklyTrigger ?? null,
          weeklyTriggerFrom: pos.weeklyTriggerFrom ?? null,
          dailyTrigger: pos.dailyTrigger ?? null,
        });
      }
    }
  } catch (e) {
    console.warn(`[Ambush] trigger maintenance skipped: ${e.message}`);
  }

  // ── RECONCILE PHANTOMS (2026-06-03) ──────────────────────────────────────────
  // Any ACTIVE/PROTECT engine record a FRESH IBKR snapshot shows FLAT is a phantom:
  // the stop fired, the trader closed by hand, OR — the common case — an entry order
  // was REJECTED after the engine optimistically wrote the record (e.g. BUY_ENTRY hit
  // the bridge's CLOSE_BLACKOUT at 15:55-16:05; that produced the 13 TXG/MOD/SMCI/...
  // phantoms). Clear it to STALKING so the banner stops flashing 'Ambush: LONG X |
  // IBKR: flat' and the name can re-enter on a fresh 1-bar break. Runs WITHOUT a live
  // price (unlike the in-loop guard), so phantoms clear after the close too. Safeguards:
  // fresh snapshot (≤10m), IBKR truly FLAT (not opposite — auto-adopt owns that), and
  // the position was NOT opened/added in the last 90s (a brand-new fill may not be in
  // the 60s sync). We do NOT fabricate an exit PnL — the real fill is in IBKR.
  if (ibkrSnapAgeMin <= 10) {
    for (const pos of allPositions) {
      if (pos.state !== STATES.ACTIVE && pos.state !== STATES.PROTECT) continue;
      if ((+pos.totalShares || 0) === 0) continue;
      const ibSh = ibkrSharesByTicker[pos.ticker];
      if (typeof ibSh === 'number' && ibSh !== 0) continue; // IBKR holds it (same or opp side)
      const stamps = [pos.adoptedAt, pos.lotFills?.[0]?.at, pos.lotFills?.[pos.lotFills.length - 1]?.at]
        .filter(Boolean).map(x => new Date(x).getTime()).filter(n => !isNaN(n));
      const newestActivity = stamps.length ? Math.max(...stamps) : 0;
      if (newestActivity && (Date.now() - newestActivity) < 90000) continue; // too fresh — await sync
      const engineShares = pos.totalShares;
      await upsertAmbushPosition(db, pos.ticker, {
        state: STATES.STALKING, direction: pos.direction, originalEntry: pos.originalEntry,
        entryPrice: null, avgCost: null, totalShares: 0, lotPlan: null, nextLot: 0, stop: null, lotFills: null,
        atBE: false, trailingActive: false, beDate: null, peak: 0,
        prevBarLow: null, prevBarHigh: null, syntheticBar: null, prevSyntheticBar: null,
        cycleNum: (pos.cycleNum || 0) + 1, todayDate: today, livePriceAt: now,
        reconciledFlat: `IBKR_FLAT_AUTO_${today}`,
      });
      pos.state = STATES.STALKING; pos.totalShares = 0; // reflect in-memory so Phase A skips it
      actions.push({ type: 'AUTO_RECONCILE_FLAT', ticker: pos.ticker, engineShares, ibkrShares: ibSh ?? 0 });
      console.log(`[Ambush] AUTO-RECONCILE: ${pos.ticker} ${pos.direction} ${engineShares}sh -> FLAT (IBKR flat, snapshot ${ibkrSnapAgeMin.toFixed(0)}m). Phantom cleared.`);
    }
  }

  // ═══ PHASE A: Process existing ACTIVE + PROTECT positions ═══
  const activePositions = allPositions.filter(p =>
    p.state === STATES.ACTIVE || p.state === STATES.PROTECT
  );

  for (const pos of activePositions) {
    try {
      const price = livePrices[pos.ticker];
      if (!price) continue;

      const isLong = pos.direction === 'LONG';

      // ══ RECONCILE-BEFORE-ACT — THE comprehensive guard (2026-06-03) ══════════
      // The engine places an order for this position ONLY if a FRESH IBKR snapshot
      // confirms IBKR actually holds it on the SAME side. Otherwise it places
      // NOTHING. This is the single chokepoint that prevents every naked-order
      // failure seen today: stops placed on sold positions, exits of phantom
      // shares, and resting stops that flipped positions short. If IBKR shows the
      // ticker flat / opposite, or the snapshot is stale (bridge down → can't
      // verify → don't act), skip ALL order management for it this tick. A
      // just-entered position not yet in the 60s sync is simply skipped one tick,
      // then managed normally once it appears in IBKR.
      {
        const ibSh = ibkrSharesByTicker[pos.ticker];
        const wantSign = isLong ? 1 : -1;
        const ibkrConfirms = ibkrSnapAgeMin <= 10
          && typeof ibSh === 'number' && ibSh !== 0 && Math.sign(ibSh) === wantSign;
        if (!ibkrConfirms) {
          // IBKR flat/opposite or snapshot stale → place NOTHING this tick. A true
          // phantom (IBKR fresh-flat) was already cleared by the reconcile pass before
          // Phase A; reaching here means stale snapshot or a <90s fill awaiting sync.
          const why = ibkrSnapAgeMin > 10 ? `snapshot ${ibkrSnapAgeMin.toFixed(0)}m stale` : `IBKR holds ${ibSh ?? 0}`;
          console.warn(`[Ambush] RECONCILE-GUARD: skip ${pos.ticker} ${pos.direction} ${pos.totalShares}sh — ${why}. No order placed.`);
          continue;
        }
      }

      // ══ IBKR IS THE SOURCE OF TRUTH FOR COST BASIS (2026-06-04, permanent) ═══
      // The reconcile-guard above just CONFIRMED a fresh (<=10m) IBKR snapshot holds
      // this ticker on our side, so IBKR's avgCost is authoritative — adopt it HERE,
      // before lot-add (Check A), exit-P&L, peak, and the PROTECT check below all
      // read pos.avgCost.
      //
      // ROOT CAUSE this fixes: the lot-add path (Check A) recomputes avgCost from
      // MODELED ladder prices (originalEntry*(1+offset)). Real fills land elsewhere
      // (slippage, commissions, partials), and NOTHING ever pulled avgCost back to
      // IBKR — so every multi-lot position understated cost (e.g. STRL eng $936.05 vs
      // IBKR $963.66), inflating open P&L and intermittently mis-flagging PROTECT
      // (the stop reads "above cost" against a fake-low basis). This makes the Ambush
      // book honor the SAME locked rule the 679 book already enforces in
      // assistantLiveReconcile.js (feedback_avg_cost_correctness, 2026-05-06): when
      // IBKR holds a position, stored avgCost MUST equal IBKR's avgCost. The modeled
      // lot value is now only a sub-60s placeholder, always reconciled to truth on the
      // next tick. Persisted by the first-hour upsert and the main save below.
      {
        const ibkrAvg = ibkrAvgByTicker[pos.ticker];
        if (ibkrAvg > 0) {
          const corr = ibkrAvg - (+pos.avgCost || 0); // +ve => engine was UNDERstating cost
          if (Math.abs(corr) >= 0.10) {
            console.log(`[Ambush] AVGCOST-SYNC ${pos.ticker} ${pos.direction}: eng ${(+pos.avgCost || 0).toFixed(4)} -> IBKR ${ibkrAvg.toFixed(4)} | basis ${corr > 0 ? '+' : ''}${corr.toFixed(2)}/sh x ${pos.totalShares}sh = ${corr > 0 ? '+' : ''}$${(corr * (+pos.totalShares || 0)).toFixed(2)}`);
          }
          pos.avgCost = +(+ibkrAvg).toFixed(4);
        }
      }

      // ── During first hour: only collect data, skip price checks ──
      if (isFirstHour) {
        await upsertAmbushPosition(db, pos.ticker, {
          syntheticBar: pos.syntheticBar,
          prevSyntheticBar: pos.prevSyntheticBar,
          todayFirstHourLow: pos.todayFirstHourLow,
          todayFirstHourHigh: pos.todayFirstHourHigh,
          todayDate: pos.todayDate,
          avgCost: pos.avgCost,          // persist the IBKR-synced cost basis even during first hour
          livePrice: price,
          livePriceAt: now,
        });
        continue;
      }

      // V7.3 lot-based trailing: NO daily first-hour-low ratchet.
      let exited = false;

      // Close the position, log the trade, drop to STALKING, queue the exit order.
      const doLiveExit = async (exitLevel, exitType, actionType) => {
        // ── RECONCILE-BEFORE-ACT GUARD (2026-06-03) ──────────────────────────
        // Verify the live IBKR position before placing any exit. If IBKR holds 0
        // or the OPPOSITE side, the engine's position is a phantom — a SELL/COVER
        // here would OPEN the wrong side (the AVGO short). Refuse, reconcile the
        // engine record to FLAT, and place NO order. Only enforced when the IBKR
        // snapshot is fresh (<=10 min); when stale, fall back to the engine count
        // (the bridge is down in that case, so nothing executes anyway).
        const ibkrSh    = ibkrSharesByTicker[pos.ticker];
        const wantSign  = isLong ? 1 : -1;
        const snapFresh = ibkrSnapAgeMin <= 10;
        if (snapFresh && !(typeof ibkrSh === 'number' && ibkrSh !== 0 && Math.sign(ibkrSh) === wantSign)) {
          console.error(`[Ambush] RECONCILE GUARD: refusing ${actionType} on ${pos.ticker} ${pos.direction} ${pos.totalShares}sh — IBKR holds ${ibkrSh ?? 0}. Reconciling engine record to FLAT; no phantom order placed.`);
          await upsertAmbushPosition(db, pos.ticker, {
            state: STATES.STALKING, direction: pos.direction, originalEntry: pos.originalEntry,
            entryPrice: null, avgCost: null, totalShares: 0, lotPlan: null, nextLot: 0, stop: null, lotFills: null,
            atBE: false, trailingActive: false, beDate: null, peak: 0,
            prevBarLow: null, prevBarHigh: null, syntheticBar: null, prevSyntheticBar: null,
            cycleNum: (pos.cycleNum || 0) + 1, todayDate: today, livePrice: price, livePriceAt: now,
            reconciledFlat: `IBKR_${ibkrSh ?? 0}_AT_${exitType}_${today}`,
          });
          actions.push({ type: 'RECONCILE_SKIP_EXIT', ticker: pos.ticker, engineShares: pos.totalShares, ibkrShares: ibkrSh ?? 0, reason: exitType });
          exited = true;
          return;
        }
        // Never exit more than IBKR actually holds (partial divergence guard).
        const exitShares = (snapFresh && typeof ibkrSh === 'number')
          ? Math.min(pos.totalShares, Math.abs(ibkrSh))
          : pos.totalShares;

        const exitPrice = exitSlip(exitLevel, pos.direction);
        const comm = calcCommission(exitShares, exitPrice);
        let pnl, borrow = 0;
        if (isLong) {
          pnl = +(exitShares * exitPrice - comm - exitShares * pos.avgCost).toFixed(2);
        } else {
          const entryD = pos.entryDate ? new Date(pos.entryDate) : new Date();
          const exitD = new Date(today);
          const tradingDays = Math.max(1, Math.round((exitD - entryD) / 86400000 * 5 / 7));
          borrow = calcBorrowCost(exitShares, pos.avgCost, tradingDays, getSectorName(pos.ticker));
          pnl = +(exitShares * (pos.avgCost - exitPrice) - comm - borrow).toFixed(2);
        }
        const trade = {
          ticker: pos.ticker, direction: pos.direction, entryPrice: pos.avgCost,
          exitPrice, shares: exitShares, pnl, entryDate: pos.entryDate,
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
          entryPrice: null, avgCost: null, totalShares: 0, lotPlan: null, nextLot: 0, stop: null, lotFills: null,
          atBE: false, trailingActive: false, beDate: null, peak: 0,
          prevBarLow: null, prevBarHigh: null, syntheticBar: null, prevSyntheticBar: null,
          todayFirstHourLow: pos.todayFirstHourLow, todayFirstHourHigh: pos.todayFirstHourHigh,
          todayDate: today, livePrice: price, livePriceAt: now,
        });
        await enqueueAmbushOrder(db, isLong ? 'SELL_EXIT' : 'COVER_EXIT', {
          ticker: pos.ticker, shares: exitShares, direction: pos.direction, reason: exitType,
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
          // NOTE: this modeled avgCost is a sub-60s PLACEHOLDER only. The IBKR-truth
          // sync at the top of this loop overwrites avgCost with the broker's real
          // average on the very next tick. Do NOT treat this line as the cost basis.
          pos.avgCost = +((oldCost + fillPrice * lotShares) / pos.totalShares).toFixed(4);
          pos.nextLot++;
          // Timestamp this lot fill for the Lot Plan panel (lot index = pos.nextLot - 1).
          pos.lotFills = [...(pos.lotFills || []), { lot: pos.nextLot - 1, at: now, price: fillPrice }];

          // V7.6 (2026-06-03): the protective stop is the CURRENT 2-bar-low and is
          // managed SOLELY by Check B (2BAR_TRACK) below. The old V7.3 lot-based
          // trailing stop (move the stop to the previous lot's trigger on each lot
          // fill) was REMOVED — it was a SECOND, conflicting protective-stop manager
          // that raced Check B and left TWO resting SELL stops in IBKR (the ALAB
          // duplicate: LOT_TRAIL @365.04 + 2BAR_TRACK @352.26 on 2026-06-03). On a
          // lot fill, Check A now ONLY records the fill + places the next lot trigger;
          // it never touches the protective stop. One manager, one stop.

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

      // Check B: 2-BAR-LOW EXIT STOP (V7.6, 2026-06-03) — maintain a REAL resting STP order
      // in IBKR at the CURRENT 2-bar level = (lowest low of the last 2 COMPLETED hourly bars
      // − $0.01) for longs / (highest high + $0.01) for shorts, computed from the verified
      // IBKR feed (pos.prevSyntheticBar/prevBarLow are seeded from it above). The stop TRACKS
      // that level — it moves UP *and* DOWN with it (the trader's explicit rule, confirmed
      // 2026-06-03), NOT a one-way ratchet. Whenever the level changes by ≥ $0.01 we push
      // MODIFY_STOP (cancel + replace), so IBKR always holds exactly one resting order at the
      // exact rule level and executes the exit itself — even if the engine/bridge is down.
      // Check C below is a redundant engine fast-path; the reconcile-before-act guard prevents
      // any double-exit if both fire.
      if (!exited && pos.atBE && pos.prevSyntheticBar && pos.prevBarLow != null && pos.prevBarHigh != null) {
        const trail = isLong
          ? +(Math.min(pos.prevSyntheticBar.low, pos.prevBarLow) - 0.01).toFixed(2)
          : +(Math.max(pos.prevSyntheticBar.high, pos.prevBarHigh) + 0.01).toFixed(2);
        // VERIFY the stop actually EXISTS in IBKR — not just that the record's level
        // matches. pos.stop is the engine's intent; it diverges when the stop was never
        // placed (an adopted position set pos.stop but enqueued no order → Check B then
        // skipped because trail≈pos.stop → NAKED: MKSI/TXN on 2026-06-03) or a stop was
        // cancelled. Force a (re)place when a FRESH snapshot shows no protective stop on
        // the exit side. The bridge's MODIFY_STOP sweeps+places exactly one, so a repeat
        // place while the 60s snapshot catches up is idempotent (never a duplicate).
        const wantAction = isLong ? 'SELL' : 'BUY';
        const stopMissingInIbkr = ibkrSnapAgeMin <= 10 && !(ibkrStopSidesByTicker[pos.ticker]?.has(wantAction));
        if (pos.stop == null || Math.abs(trail - pos.stop) >= 0.01 || stopMissingInIbkr) {
          pos.stop = trail;
          await enqueueAmbushOrder(db, 'MODIFY_STOP', {
            ticker: pos.ticker, direction: pos.direction,
            newStopPrice: pos.stop, shares: pos.totalShares, reason: stopMissingInIbkr ? '2BAR_TRACK_REPLACE_NAKED' : '2BAR_TRACK',
          });
          actions.push({ type: 'TRACK_STOP', ticker: pos.ticker, stop: pos.stop, naked: stopMissingInIbkr || undefined });
        }
      }

      // Check C: Hard stop (pre-BE = first-hour stop; post-BE = trailed/lot/breakeven stop).
      if (!exited && pos.stop != null) {
        if (isLong && price <= pos.stop) {
          await doLiveExit(pos.stop, pos.atBE ? 'LOT_STOP' : '1H_LOW_BREAK', pos.atBE ? 'LOT_EXIT' : '1H_EXIT');
        } else if (!isLong && price >= pos.stop) {
          await doLiveExit(pos.stop, pos.atBE ? 'LOT_STOP' : '1H_HIGH_BREAK', pos.atBE ? 'LOT_EXIT' : '1H_EXIT');
        }
      }

      // Check D: Break Even ($75 unrealized -> stop to breakeven, PROTECT).
      // V7.4: disabled (AMBUSH_BE75_SNAP=false). Peak is still tracked for display;
      // positions enter with atBE=true so the 2-bar exit + lot-trail run from entry.
      if (!exited) {
        const unr = isLong
          ? (price - pos.avgCost) * pos.totalShares
          : (pos.avgCost - price) * pos.totalShares;
        if (unr > (pos.peak || 0)) pos.peak = +unr.toFixed(2);

        if (AMBUSH_BE75_SNAP && !pos.atBE && unr >= BE_THRESHOLD) {
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
        // V7.4: PROTECT = stop now guarantees no loss (lot-trail/2-bar lifted it to
        // breakeven-or-better). Equivalent to V7.3's atBE for the locked rules.
        const protectedNow = pos.stop != null &&
          (isLong ? pos.stop >= pos.avgCost : pos.stop <= pos.avgCost);
        await upsertAmbushPosition(db, pos.ticker, {
          state: protectedNow ? STATES.PROTECT : STATES.ACTIVE,
          stop: pos.stop,
          avgCost: pos.avgCost,
          totalShares: pos.totalShares,
          nextLot: pos.nextLot,
          lotFills: pos.lotFills,
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
  // During first hour, skip re-entries (need first-hour data first). Skip the open
  // blackout and the post-bell window (inEntryBlackout) — but re-entries fire right up
  // to the 4:00 close, same as new entries.
  if (!isFirstHour && !inEntryBlackout) {
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

        // RECONCILE-BEFORE-ACT (entry): only enter if a FRESH IBKR snapshot confirms we
        // are FLAT in this ticker. If IBKR already holds it (any side) or the snapshot is
        // stale (can't verify), do NOT enter on top — skip this tick.
        {
          const ibSh = ibkrSharesByTicker[pend.ticker];
          if (!(ibkrSnapAgeMin <= 10) || (typeof ibSh === 'number' && ibSh !== 0)) {
            console.warn(`[Ambush] ENTRY GUARD: skip re-entry ${pend.ticker} — ${ibkrSnapAgeMin > 10 ? 'snapshot stale' : 'IBKR already holds ' + ibSh}.`);
            continue;
          }
        }

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

        // Transition ATTACK -> FILLING (NOT held until IBKR confirms the fill)
        await upsertAmbushPosition(db, pend.ticker, {
          state: STATES.FILLING,
          pendingFill: true,
          orderEnqueuedAt: now,
          direction: pend.direction,
          entryPrice: rePrice,
          avgCost: rePrice,
          totalShares: 0,                  // promoted to sizing.l1Shares only on IBKR confirmation
          intendedShares: sizing.l1Shares,
          lotPlan: sizing.lotPlan,
          nextLot: 1,
          lotFills: null,
          originalEntry: pend.originalEntry || rePrice,
          stop: reStop,
          atBE: !AMBUSH_BE75_SNAP, // V7.4: 2-bar exit + lot-trail active from entry
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
    // Re-entry candidacy = SAME gates as a fresh entry (Scott 2026-06-03): weekly BL+1/
    // SS+1 still intact + the DAILY 2-day-high/low trigger still intact AT PRESENT PRICE
    // + the 1-bar live break. Fetch prior-day highs/lows for the daily-trigger check
    // (incremental cache; shared with Phase D).
    const reEntryPriorData = await fetchPriorDayData(stalkingPositions.map(p => p.ticker), today);

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

        // Check regime + sector. V7.4: regime gate removed — re-enter in any regime.
        if (AMBUSH_REGIME_GATE) {
          const regime = getRegime(ctx, stalk.ticker, today);
          if (isLong && !regime) continue;
          if (!isLong && regime) continue;
        }
        if (!getSectorOk(ctx, stalk.ticker, today)) continue;

        // FROZEN-TRIGGER GATE (2026-06-03, Scott's rule): re-enter only while the current
        // price still holds above BOTH frozen breakout levels (long) / below both (short):
        //   • Weekly Trigger = the active weekly BL/SS breakout entry (e.g. 420.51)
        //   • Daily Trigger  = the ORIGINAL 2-day breakout level that first fired this cycle
        // These were frozen + persisted by the maintenance pass above. The check is stateless
        // each tick, so if price dips below and later crosses back above both, the name is
        // eligible again. Falls back to today's rolling 2-day level if a trigger isn't frozen
        // yet (degrades to the prior gate, never re-enters blind). If price has sold off below
        // either, it stays STALKING and waits — it does NOT chase.
        {
          const rolling = rolling2Day(reEntryPriorData[stalk.ticker], isLong);
          const dailyFloor  = (stalk.dailyTrigger != null) ? stalk.dailyTrigger : rolling;
          const weeklyFloor = (stalk.weeklyTrigger != null) ? stalk.weeklyTrigger : null;
          if (dailyFloor == null) continue; // no breakout level known yet — don't re-enter blind
          if (isLong) {
            if (price < dailyFloor) continue;                      // sold off below the daily breakout
            if (weeklyFloor != null && price < weeklyFloor) continue; // below the weekly breakout
          } else {
            if (price > dailyFloor) continue;
            if (weeklyFloor != null && price > weeklyFloor) continue;
          }
        }

        // Update running low/high from live price
        if (price < (stalk.runningLow || Infinity)) stalk.runningLow = price;
        if (price > (stalk.runningHigh || -Infinity)) stalk.runningHigh = price;

        // Need the most-recent completed bar (prevSyntheticBar) as the 1-bar re-entry
        // reference. Seeded from the verified IBKR feed; until it arrives, just track.
        if (!stalk.prevSyntheticBar) {
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

        // ── 1-BAR LIVE RE-ENTRY (2026-06-03) ──────────────────────────────────────
        // Scott's rule: re-enter the moment LIVE PRICE breaks the most-recent COMPLETED
        // hourly bar's high (long) / low (short) — a 1-BAR break, evaluated EVERY 60s
        // tick. The old path used isConfirmedGreenBreakout/RedBreakdown (a 2-bar
        // wait-for-CLOSE confirmation) and only ran once per hour on bar rollover, so
        // fast intra-hour re-entries (AVGO/ARCT/AKAM) were missed entirely. The
        // reference is prevSyntheticBar = the most-recent completed bar, seeded from the
        // verified IBKR feed (= the trader's TWS chart). (A protective exit is a 2-bar
        // break; a re-entry is a 1-bar break — different rules, per Scott.)
        const prevBar = stalk.prevSyntheticBar;  // most-recent completed hourly bar
        const breakoutLevel = isLong
          ? +(prevBar.high + 0.01).toFixed(2)
          : +(prevBar.low - 0.01).toFixed(2);
        const breakoutDetected = isLong ? price >= breakoutLevel : price <= breakoutLevel;

        if (breakoutDetected) {
          // Transition STALKING -> ATTACK; Phase B fills at the live price next tick.
          await upsertAmbushPosition(db, stalk.ticker, {
            state: STATES.ATTACK,
            direction: stalk.direction,
            originalEntry: stalk.originalEntry,
            runningLow: stalk.runningLow || prevBar.low,
            runningHigh: stalk.runningHigh || prevBar.high,
            cycleNum: stalk.cycleNum || 0,
            todayFirstHourLow: stalk.todayFirstHourLow,
            todayFirstHourHigh: stalk.todayFirstHourHigh,
            todayDate: today,
            syntheticBar: null,
            prevSyntheticBar: null,
            prevBarLow: stalk.prevBarLow,
            prevBarHigh: stalk.prevBarHigh,
            livePrice: price,
            livePriceAt: now,
          });

          actions.push({
            type: 'BREAKOUT_DETECTED', ticker: stalk.ticker,
            direction: stalk.direction, price, level: breakoutLevel,
          });
        } else {
          // No break yet — keep tracking; re-check on the NEXT tick (no per-hour gate).
          await upsertAmbushPosition(db, stalk.ticker, {
            runningLow: stalk.runningLow,
            runningHigh: stalk.runningHigh,
            syntheticBar: stalk.syntheticBar,
            prevSyntheticBar: stalk.prevSyntheticBar,
            prevBarLow: stalk.prevBarLow,
            prevBarHigh: stalk.prevBarHigh,
            todayFirstHourLow: stalk.todayFirstHourLow,
            todayFirstHourHigh: stalk.todayFirstHourHigh,
            todayDate: stalk.todayDate,
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
  if (!isFirstHour && !inEntryBlackout && mceCandidates.length > 0) {
    // Step 1: Pre-filter — regime + sector + signal + 2-day trigger
    const priorDayData = await fetchPriorDayData(mceCandidates, today);
    const breakoutCandidates = [];

    for (const ticker of mceCandidates) {
      const price = livePrices[ticker];
      if (!price) continue;

      if (!getSectorOk(ctx, ticker, today)) continue;

      // V7.4: regime gate removed — take BL+1 longs AND SS+1 shorts in any regime.
      // (BL and SS are mutually exclusive per ticker; long takes precedence if ever both.)
      let direction = null;
      if (AMBUSH_REGIME_GATE) {
        const regime = getRegime(ctx, ticker, today);
        if (regime && isActiveBL(ctx, ticker, today)) direction = 'LONG';
        else if (!regime && isActiveSS(ctx, ticker, today)) direction = 'SHORT';
      } else {
        if (isActiveBL(ctx, ticker, today)) direction = 'LONG';
        else if (isActiveSS(ctx, ticker, today)) direction = 'SHORT';
      }
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
    // HUNTING (read-only): surface the daily-cleared candidates to the dashboard.
    huntingList = breakoutCandidates.map(c => ({ ticker: c.ticker, direction: c.direction }));

    // Step 2: For the narrow candidate set, fetch FMP hourly bars for breakout check
    if (breakoutCandidates.length > 0) {
      console.log(`[Ambush] MCE: ${breakoutCandidates.length} tickers passed pre-filter, checking hourly breakout...`);
      const candidateTickers = breakoutCandidates.map(c => c.ticker);
      const hourlyBars = await fetchFmpHourlyBars(candidateTickers);

      for (const { ticker, direction } of breakoutCandidates) {
        try {
          const hBars = hourlyBars[ticker];
          if (!hBars || hBars.length < 1) continue;
          const todayOnlyBars = hBars.filter(b => b.date.startsWith(today));
          if (todayOnlyBars.length < 1) continue;

          // ── V7.4 N=1 ENTRY (validated, executable) ──────────────────────────
          // The daily 2-day-high is already cleared (breakoutCandidate). The trigger
          // is a REAL-TIME break of the high of the most-recent COMPLETED hourly bar
          // (N=1), caught on this 60s tick — NOT a closed-bar green confirmation, and
          // NOT a 2-bar wait. Fill at the live price (≈ the breakout, caught <60s).
          // Stop = first-hour low/high. Earliest entry ~10:30 (break the opening hour).
          const currentPrice = livePrices[ticker];
          if (!currentPrice) continue;
          const barEndMin = (b) => {
            const t = extractTime(b.date);
            return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10) + 60;
          };
          const completed = todayOnlyBars
            .filter(b => barEndMin(b) <= et.totalMinutes)          // bar's hour has fully ended
            .sort((a, b) => a.date.localeCompare(b.date));
          if (completed.length < 1) continue;                      // need the prior (≥ first-hour) bar
          const priorBar = completed[completed.length - 1];        // most-recent completed hourly bar (N=1 reference)

          const firstHourBars = todayOnlyBars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
          let ep, stop;
          if (direction === 'LONG') {
            const breakoutLevel = +(priorBar.high + 0.01).toFixed(2);
            if (currentPrice < breakoutLevel) continue;            // hasn't broken the prior bar's high yet
            ep = entrySlip(currentPrice, 'LONG');
            const firstHourLow = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
            if (!firstHourLow || firstHourLow >= ep) continue;
            stop = +(firstHourLow - COMMISSION_PER_SHARE).toFixed(2);
            if (stop >= ep) continue;
          } else {
            const breakoutLevel = +(priorBar.low - 0.01).toFixed(2);
            if (currentPrice > breakoutLevel) continue;            // hasn't broken the prior bar's low yet
            ep = entrySlip(currentPrice, 'SHORT');
            const firstHourHigh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;
            if (!firstHourHigh || firstHourHigh <= ep) continue;
            stop = +(firstHourHigh + COMMISSION_PER_SHARE).toFixed(2);
            if (stop <= ep) continue;
          }

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

          // RECONCILE-BEFORE-ACT (entry): only open a new position if a FRESH IBKR
          // snapshot confirms we are FLAT in this ticker. Never enter on top of an
          // existing IBKR position, and never enter blind on a stale snapshot.
          {
            const ibSh = ibkrSharesByTicker[ticker];
            if (!(ibkrSnapAgeMin <= 10) || (typeof ibSh === 'number' && ibSh !== 0)) {
              console.warn(`[Ambush] ENTRY GUARD: skip new entry ${ticker} — ${ibkrSnapAgeMin > 10 ? 'snapshot stale' : 'IBKR already holds ' + ibSh}.`);
              continue;
            }
          }

          // Create new ACTIVE position
          const todayHigh = Math.max(...todayOnlyBars.map(b => b.high));
          const todayLow = Math.min(...todayOnlyBars.map(b => b.low));

          await upsertAmbushPosition(db, ticker, {
            state: STATES.FILLING,           // NOT held until IBKR confirms the fill
            pendingFill: true,
            orderEnqueuedAt: now,
            direction,
            entryPrice: ep,
            avgCost: ep,
            totalShares: 0,                  // promoted to sizing.l1Shares only on IBKR confirmation
            intendedShares: sizing.l1Shares,
            lotPlan: sizing.lotPlan,
            nextLot: 1,
            lotFills: null,
            originalEntry: ep,
            stop,
            atBE: !AMBUSH_BE75_SNAP, // V7.4: 2-bar exit + lot-trail active from entry
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
    watching,
    hunting: huntingList,
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
