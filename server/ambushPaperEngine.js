// server/ambushPaperEngine.js
// ── PNTHR AMBUSH V7.6 — STRUCTURALLY-ISOLATED PAPER ENGINE ───────────────────
//
// A faithful PAPER replica of the live Ambush V7.6 intraday strategy, walled off
// from the real-money path EXACTLY like Elite (server/eliteAiEngine.js):
//   • Writes ONLY pnthr_ambush_paper_positions / pnthr_ambush_paper_trades / _config.
//   • Imports NO order/IBKR/bridge code — never enqueueAmbushOrder, never the outbox,
//     never pnthr_ibkr_positions. It CANNOT reach IBKR. Pure simulation off FMP data.
//
// It reuses the PURE V7.6 functions from ambush/ambushEngine.js (signal context,
// sizing, gates, slippage) and replicates the V7.6 DECISIONS verified against
// ambush/ambushCron.js:
//   • Entry (Phase D): active weekly BL/SS  +  daily 2-day-high cleared  +  N=1 break
//     of the most-recent COMPLETED :00 clock-hour bar (any color), fill at live price,
//     stop = first-hour (9:30-10:00) low − commission. Sector heat-map gate; no regime gate.
//   • Pyramid (Check A): 5-lot ladder, adds at +3/6/10/14% of the L1 entry, 10% NAV ticker cap.
//   • Exit (Check B/C): 2-bar trailing stop = min(last 2 completed clock-hour lows) − $0.01,
//     tracks up AND down; exit when price touches it. (BE-snap is off in V7.6; trail governs from entry.)
//   • Re-entry (Phase C): green-confirmed close above the prior bar's high, while price holds
//     above the FROZEN daily 2-day trigger; re-entry stop = the green bar's low − $0.01.
//
// Faithfulness notes (disclosed on the dashboard):
//   • Bars are FMP :00 clock-hour bars — the same basis as the +789% backtest (the live
//     engine uses tick-synthetic bars only as a between-fetch real-time approximation).
//   • Fills model the breakout/trigger level with V7.6's 5bps slippage; GROSS of commission
//     and borrow (matches Elite paper's gross basis — the dashboard discloses this).
// ────────────────────────────────────────────────────────────────────────────
import { connectToDatabase, getUserProfile } from './database.js';
import {
  getAiTickers, loadSignalContext, isActiveBL, isActiveSS, getSectorOk, getWeeklyTrigger,
  getSizingMultiplier, getSizingTierLabel, sizeLots, entrySlip, exitSlip, getSectorName,
  extractTime, LOT_OFFSETS, FIRST_HOUR_END, COMMISSION_PER_SHARE, TICKER_CAP_PCT,
} from './ambush/ambushEngine.js';

const COLL   = 'pnthr_ambush_paper_positions';
const TRADES = 'pnthr_ambush_paper_trades';
const CFG    = 'pnthr_ambush_paper_config';
const FMP    = 'https://financialmodelingprep.com/api/v3';
const MIN_SHORT_PRICE = 10;          // V7.6: never short a sub-$10 name
const SOURCE = 'AMBUSH_V76_PAPER';

// ── ET time helpers ──────────────────────────────────────────────────────────
function etNow() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const p = {}; for (const x of parts) p[x.type] = x.value;
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;   // Intl can emit "24" for midnight
  return { dow: p.weekday, totalMinutes: h * 60 + parseInt(p.minute, 10) };
}
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── Short-TTL caches so a 10s loop doesn't storm FMP ─────────────────────────
const _quoteCache = { at: 0, data: {} };       // { TICKER: {price, change} }, ~8s TTL
const _barCache = new Map();                    // ticker -> { day, at, bars:[30min] }, ~5min TTL
const _priorDayCache = new Map();               // ticker -> { day, highs:[], lows:[] }

// FMP batch quotes → { TICKER: { price, change } }. change = today's % move (heat-map gate).
async function fetchQuotes(tickers) {
  const now = Date.now();
  const need = tickers.filter(t => !(t in _quoteCache.data) || (now - _quoteCache.at) > 8000);
  if (need.length && (now - _quoteCache.at) > 8000) {
    const K = process.env.FMP_API_KEY; const out = {};
    for (let i = 0; i < tickers.length; i += 100) {
      const batch = tickers.slice(i, i + 100);
      try {
        const r = await fetch(`${FMP}/quote/${batch.join(',')}?apikey=${K}`);
        const j = await r.json();
        if (Array.isArray(j)) for (const q of j) {
          if (q.price != null) out[(q.symbol || '').toUpperCase()] = { price: +q.price, change: (typeof q.changesPercentage === 'number' ? q.changesPercentage : null) };
        }
      } catch { /* skip batch */ }
    }
    _quoteCache.data = out; _quoteCache.at = now;
  }
  const res = {};
  for (const t of tickers) if (_quoteCache.data[t]) res[t] = _quoteCache.data[t];
  return res;
}

// FMP 30-min bars (cached ~5min — they only change every 30 min).
async function fetch30Min(ticker, day) {
  const c = _barCache.get(ticker);
  if (c && c.day === day && (Date.now() - c.at) < 300000) return c.bars;
  const K = process.env.FMP_API_KEY;
  let bars = [];
  try {
    const r = await fetch(`${FMP}/historical-chart/30min/${ticker}?apikey=${K}`);
    const j = await r.json();
    if (Array.isArray(j)) bars = j;
  } catch { /* leave empty */ }
  _barCache.set(ticker, { day, at: Date.now(), bars });
  return bars;
}

// Aggregate 30-min bars into COMPLETED :00 clock-hour bars (match TWS + the backtest).
// A clock hour is complete once its end (hr+1:00) has passed; the forming hour is dropped.
function clockHourBars(min30, today, nowTotalMin) {
  const byHour = {};
  for (const b of (min30 || [])) {
    if (!b.date || !b.date.startsWith(today)) continue;
    const hr = parseInt(extractTime(b.date).slice(0, 2), 10);
    (byHour[hr] = byHour[hr] || []).push(b);
  }
  const out = [];
  for (const hr of Object.keys(byHour).map(Number).sort((a, b) => a - b)) {
    if ((hr + 1) * 60 > nowTotalMin) continue;
    const bs = byHour[hr].sort((a, b) => a.date.localeCompare(b.date));
    out.push({
      date: `${today} ${String(hr).padStart(2, '0')}:00:00`,
      open: +bs[0].open, high: Math.max(...bs.map(x => +x.high)),
      low: Math.min(...bs.map(x => +x.low)), close: +bs[bs.length - 1].close,
    });
  }
  return out; // chronological completed clock-hour bars
}

// Prior-day 2-day highs/lows (excludes today). Cached per day.
async function priorDay(ticker, day) {
  const c = _priorDayCache.get(ticker);
  if (c && c.day === day) return c;
  const K = process.env.FMP_API_KEY;
  let highs = [], lows = [];
  try {
    const r = await fetch(`${FMP}/historical-price-full/${ticker}?timeseries=6&apikey=${K}`);
    const j = await r.json();
    const hist = (j.historical || []).filter(b => b.date < day).slice(0, 2); // 2 most-recent completed days
    highs = hist.map(b => +b.high); lows = hist.map(b => +b.low);
  } catch { /* leave empty */ }
  const out = { day, highs, lows };
  _priorDayCache.set(ticker, out);
  return out;
}
function rolling2Day(pd, isLong) {
  if (!pd || !pd.highs?.length) return null;
  return isLong ? +(Math.max(...pd.highs) + 0.01).toFixed(2) : +(Math.min(...pd.lows) - 0.01).toFixed(2);
}

// Real account NAV (same source as Elite + live Ambush) — sizes the paper book realistically.
async function getActualNav(db) {
  let nav = 83000;
  try {
    const cfg = await db.collection('pnthr_ambush_config').findOne({});
    if (cfg?.nav > 0) nav = cfg.nav;
    if (cfg?.ownerId) { const p = await getUserProfile(cfg.ownerId); if (p?.accountSize > 0) nav = p.accountSize; }
  } catch { /* default */ }
  return nav;
}

// ── Main paper tick: manage held → re-enter STALKING → open new (single pass) ─
// opts.probe = run the full decision path but write NOTHING (read-only diagnostic);
//   opts.asOf ('YYYY-MM-DD') + opts.nowMin (ET minutes since midnight) replay a past
//   session for verification. The live loop calls runAmbushPaperTick() with no opts.
export async function runAmbushPaperTick(opts = {}) {
  const { probe = false, asOf = null, nowMin = null } = opts;
  const db = await connectToDatabase();
  if (!db) return { error: 'NO_DB' };
  const live = etNow();
  const dow = live.dow;
  const totalMinutes = nowMin != null ? nowMin : live.totalMinutes;
  if (!probe) {
    if (dow === 'Sat' || dow === 'Sun') return { skipped: 'WEEKEND' };
    if (totalMinutes < 570 || totalMinutes > 960) return { skipped: 'OUTSIDE_HOURS' };
  }
  // Write helpers — no-ops in probe mode so the diagnostic never touches the book.
  const wInsert = (coll, doc) => probe ? Promise.resolve() : db.collection(coll).insertOne(doc);
  const wUpdate = (coll, filter, upd) => probe ? Promise.resolve() : db.collection(coll).updateOne(filter, upd);
  const wDelete = (coll, filter) => probe ? Promise.resolve() : db.collection(coll).deleteOne(filter);
  const isFirstHour = totalMinutes < 600;                       // before 10:00 ET (opening bar still forming)
  const inEntryBlackout = (totalMinutes >= 565 && totalMinutes <= 575) || (totalMinutes >= 960 && totalMinutes <= 965);
  const today = asOf || todayET();

  const nav = await getActualNav(db);
  const sizeMult = getSizingMultiplier(nav);
  const ctx = await loadSignalContext(db);

  const positions = await db.collection(COLL).find({ status: { $in: ['ACTIVE', 'STALKING'] } }).toArray();
  const heldTickers = new Set(positions.filter(p => p.status === 'ACTIVE').map(p => p.ticker));
  const onBook = new Set(positions.map(p => p.ticker));

  // Candidate universe = AI-300 names with an active weekly BL/SS not already on the book.
  const candidates = isFirstHour ? [] : getAiTickers().filter(t => !onBook.has(t) && (isActiveBL(ctx, t, today) || isActiveSS(ctx, t, today)));

  // One batched quote fetch for everything we look at this tick.
  const allTk = [...new Set([...positions.map(p => p.ticker), ...candidates])];
  const quotes = await fetchQuotes(allTk);
  ctx.dayChange = {}; for (const t of allTk) if (quotes[t]?.change != null) ctx.dayChange[t] = quotes[t].change;

  const actions = [];
  let fills = 0, exits = 0, entries = 0, reentries = 0;
  const now = new Date();
  // Cash/buying-power gate (V7.3): a fund can't deploy more than it holds. Track
  // available cash = NAV − capital already in open positions; new L1 entries draw it down.
  let availableCash = nav - positions.filter(p => p.status === 'ACTIVE')
    .reduce((s, p) => s + (+p.avgCost || +p.entryPrice || 0) * (+p.totalShares || 0), 0);

  // ── 1) MANAGE held ACTIVE positions: lot fills, 2-bar trail, exit ──────────
  for (const p of positions.filter(p => p.status === 'ACTIVE')) {
    const q = quotes[p.ticker]; if (!q) continue;
    const price = q.price, isLong = p.direction === 'LONG';
    const anchor = +p.originalEntry || +p.entryPrice;
    let nextLot = p.nextLot || 1, sh = +p.totalShares || 0, avg = +p.avgCost || anchor, stop = +p.stop, changed = false;

    // (a) pyramid adds (Check A) — fill the next lot when price clears its trigger; 10% ticker cap.
    while (nextLot <= 4 && p.lotPlan) {
      const trig = isLong ? +(anchor * (1 + LOT_OFFSETS[nextLot])).toFixed(2) : +(anchor * (1 - LOT_OFFSETS[nextLot])).toFixed(2);
      const cleared = isLong ? price >= trig : price <= trig;
      if (!cleared) break;
      const addSh = +p.lotPlan[nextLot] || 0;
      if (addSh <= 0) { nextLot++; continue; }
      if ((avg * sh + trig * addSh) > nav * TICKER_CAP_PCT) break;   // 10% NAV ticker cap on adds
      avg = (avg * sh + trig * addSh) / (sh + addSh); sh += addSh; nextLot++; fills++; changed = true;
    }

    // (b) 2-bar trailing stop (Check B) — min of last 2 completed clock-hour lows − $0.01; tracks both ways.
    const bars = clockHourBars(await fetch30Min(p.ticker, today), today, totalMinutes);
    if (bars.length >= 2) {
      const last2 = bars.slice(-2);
      const trail = isLong ? +(Math.min(last2[0].low, last2[1].low) - 0.01).toFixed(2)
                           : +(Math.max(last2[0].high, last2[1].high) + 0.01).toFixed(2);
      if (Math.round(trail * 100) !== Math.round((stop || 0) * 100)) { stop = trail; changed = true; }
    }

    // (c) exit (Check C) — price touches the stop → close at the stop (gross, with slippage).
    const stopHit = stop != null && (isLong ? price <= stop : price >= stop);
    if (stopHit) {
      const exitPx = exitSlip(stop, p.direction);
      const pnl = +(isLong ? (exitPx - avg) * sh : (avg - exitPx) * sh).toFixed(2);
      await wInsert(TRADES, {
        ticker: p.ticker, direction: p.direction, signal: isLong ? 'BL' : 'SS',
        entryPrice: p.entryPrice, avgCost: +avg.toFixed(4), exitPrice: exitPx, shares: sh, pnl,
        exitReason: 'STOP', entryDate: p.entryDate, exitDate: today, cycleNum: p.cycleNum || 0,
        dryRun: true, source: SOURCE, createdAt: now,
      });
      // → STALKING so Phase C can green-confirm a re-entry while the weekly signal holds.
      await wUpdate(COLL,{ _id: p._id }, { $set: {
        status: 'STALKING', direction: p.direction, originalEntry: anchor,
        entryPrice: null, avgCost: null, totalShares: 0, nextLot: 0, stop: null, lotPlan: null,
        currentPrice: price, livePnl: 0, peak: 0, cycleNum: (p.cycleNum || 0) + 1,
        // keep the FROZEN daily trigger for the re-entry gate; reset on a new weekly cycle (Phase C).
        exitedAt: now, updatedAt: now,
      } });
      exits++;
      actions.push({ type: 'EXIT', ticker: p.ticker, pnl, exitPx });
      continue;
    }

    // (d) live P&L + peak
    const livePnl = +(isLong ? (price - avg) * sh : (avg - price) * sh).toFixed(2);
    const peak = Math.max(+p.peak || 0, livePnl);
    if (changed || price !== p.currentPrice) {
      await wUpdate(COLL,{ _id: p._id }, { $set: {
        nextLot, totalShares: sh, avgCost: +avg.toFixed(4), stop, currentPrice: price,
        livePnl, peak: +peak.toFixed(2), updatedAt: now,
      } });
    }
  }

  // ── 2) PHASE C: green-confirmed re-entry of STALKING names ─────────────────
  if (!isFirstHour) {
    for (const s of positions.filter(p => p.status === 'STALKING')) {
      const q = quotes[s.ticker]; if (!q) continue;
      const price = q.price, isLong = s.direction === 'LONG';
      // weekly signal must still be active, else retire the watch.
      if (isLong ? !isActiveBL(ctx, s.ticker, today) : !isActiveSS(ctx, s.ticker, today)) {
        await wDelete(COLL, { _id: s._id }); actions.push({ type: 'SIGNAL_EXPIRED', ticker: s.ticker }); continue;
      }
      if (!getSectorOk(ctx, s.ticker, today, s.direction)) continue;
      // freeze/refresh the daily 2-day trigger for this weekly cycle (re-entry floor).
      const wt = getWeeklyTrigger(ctx, s.ticker, today);
      const wtFrom = (wt && wt.dir === s.direction) ? wt.from : null;
      let dailyTrig = s.dailyTrigger;
      if ((s.weeklyTriggerFrom ?? null) !== wtFrom) { dailyTrig = null; }   // new cycle → recapture
      if (dailyTrig == null) dailyTrig = rolling2Day(await priorDay(s.ticker, today), isLong);
      if (dailyTrig == null) continue;
      if (isLong ? price < dailyTrig : price > dailyTrig) {                 // not back above the 2-day breakout
        await wUpdate(COLL,{ _id: s._id }, { $set: { dailyTrigger: dailyTrig, weeklyTriggerFrom: wtFrom, currentPrice: price, updatedAt: now } });
        continue;
      }
      const bars = clockHourBars(await fetch30Min(s.ticker, today), today, totalMinutes);
      if (bars.length < 2) { await wUpdate(COLL,{ _id: s._id }, { $set: { dailyTrigger: dailyTrig, weeklyTriggerFrom: wtFrom, currentPrice: price, updatedAt: now } }); continue; }
      const prevBar = bars[bars.length - 1], priorBar = bars[bars.length - 2];
      const green = isLong
        ? (prevBar.close > prevBar.open && prevBar.high > priorBar.high && prevBar.close > priorBar.high)
        : (prevBar.close < prevBar.open && prevBar.low < priorBar.low && prevBar.close < priorBar.low);
      if (!green) { await wUpdate(COLL,{ _id: s._id }, { $set: { dailyTrigger: dailyTrig, weeklyTriggerFrom: wtFrom, currentPrice: price, updatedAt: now } }); continue; }
      // re-enter: stop = green confirming bar's low − $0.01 (high + for short).
      const ep = entrySlip(price, s.direction);
      const reStop = isLong ? +(prevBar.low - 0.01).toFixed(2) : +(prevBar.high + 0.01).toFixed(2);
      if (isLong ? reStop >= ep : reStop <= ep) continue;
      const sizing = sizeLots(ep, reStop, s.direction, nav, sizeMult);
      if (!sizing) continue;
      const reCost = sizing.l1Shares * ep;
      if (reCost > availableCash) continue;                 // can't fund L1 → keep stalking
      availableCash -= reCost;
      await wUpdate(COLL,{ _id: s._id }, { $set: {
        status: 'ACTIVE', entryPrice: ep, originalEntry: ep, avgCost: ep, stop: reStop,
        lotPlan: sizing.lotPlan, nextLot: 1, totalShares: sizing.l1Shares, targetShares: sizing.totalShares,
        rps: sizing.rps, sector: getSectorName(s.ticker), atBE: true, peak: 0, livePnl: 0, currentPrice: price,
        dailyTrigger: dailyTrig, weeklyTriggerFrom: wtFrom, entryDate: today, reenteredAt: now, updatedAt: now,
      } });
      reentries++;
      actions.push({ type: 'RE_ENTRY', ticker: s.ticker, direction: s.direction, shares: sizing.l1Shares, price: ep, stop: reStop });
    }
  }

  // ── 3) PHASE D: new entries (active BL/SS + 2-day-high cleared + N=1 clock-hour break) ─
  if (!isFirstHour && !inEntryBlackout) {
    for (const ticker of candidates) {
      const q = quotes[ticker]; if (!q) continue;
      const price = q.price;
      const direction = isActiveBL(ctx, ticker, today) ? 'LONG' : (isActiveSS(ctx, ticker, today) ? 'SHORT' : null);
      if (!direction) continue;
      const isLong = direction === 'LONG';
      if (!isLong && price < MIN_SHORT_PRICE) continue;          // no sub-$10 shorts
      if (!getSectorOk(ctx, ticker, today, direction)) continue;  // heat-map gate
      // daily 2-day-high pre-filter
      const pd = await priorDay(ticker, today);
      const dailyTrig = rolling2Day(pd, isLong);
      if (dailyTrig == null) continue;
      if (isLong ? price < dailyTrig : price > dailyTrig) continue;
      // N=1 break of the most-recent completed clock-hour bar
      const bars = clockHourBars(await fetch30Min(ticker, today), today, totalMinutes);
      if (bars.length < 1) continue;
      const priorBar = bars[bars.length - 1];
      const firstHourBars = bars.filter(b => extractTime(b.date) < FIRST_HOUR_END);
      let ep, stop;
      if (isLong) {
        if (price < +(priorBar.high + 0.01).toFixed(2)) continue; // not broken yet
        ep = entrySlip(price, 'LONG');
        const fhl = firstHourBars.length ? Math.min(...firstHourBars.map(b => b.low)) : null;
        if (!fhl || fhl >= ep) continue;
        stop = +(fhl - COMMISSION_PER_SHARE).toFixed(2); if (stop >= ep) continue;
      } else {
        if (price > +(priorBar.low - 0.01).toFixed(2)) continue;
        ep = entrySlip(price, 'SHORT');
        const fhh = firstHourBars.length ? Math.max(...firstHourBars.map(b => b.high)) : null;
        if (!fhh || fhh <= ep) continue;
        stop = +(fhh + COMMISSION_PER_SHARE).toFixed(2); if (stop <= ep) continue;
      }
      const sizing = sizeLots(ep, stop, direction, nav, sizeMult);
      if (!sizing) continue;
      const l1Cost = sizing.l1Shares * ep;
      if (l1Cost > availableCash) { actions.push({ type: 'SKIPPED_CASH', ticker }); continue; }
      availableCash -= l1Cost;
      await wInsert(COLL, {
        ticker, direction, signal: isLong ? 'BL' : 'SS',
        entryPrice: ep, originalEntry: ep, avgCost: ep, stop, originalStop: stop,
        lotPlan: sizing.lotPlan, nextLot: 1, totalShares: sizing.l1Shares, targetShares: sizing.totalShares,
        rps: sizing.rps, sector: getSectorName(ticker), atBE: true, peak: 0, livePnl: 0, currentPrice: price,
        cycleNum: 0, dailyTrigger: dailyTrig, status: 'ACTIVE', dryRun: true, source: SOURCE,
        entryDate: today, createdAt: now, updatedAt: now,
      });
      onBook.add(ticker); entries++;
      actions.push({ type: 'NEW_ENTRY', ticker, direction, shares: sizing.l1Shares, price: ep, stop });
    }
  }

  return { fills, exits, entries, reentries, managed: positions.length, candidates: candidates.length, changed: !!(fills || exits || entries || reentries), actions: actions.slice(0, 12) };
}

// Independent rule re-check (the paper analogue of Ambush's IBKR-truth reconcile).
export function verifyAmbushPaperPosition(pos, nav = 100000) {
  const isLong = pos.direction === 'LONG';
  const avg = +pos.avgCost || +pos.entryPrice, stop = +pos.stop, sh = +pos.totalShares || 0;
  const cur = +pos.currentPrice || avg;
  const checks = {};
  checks.direction = ((pos.signal === 'BL') === isLong) ? { status: 'green' } : { status: 'red', reason: `${pos.signal}≠${pos.direction}` };
  checks.stopLevel = (stop && (isLong ? stop < cur : stop > cur)) ? { status: 'green' } : { status: 'red', reason: `stop wrong side of ${cur}` };
  const notional = sh * avg;
  checks.cap = (notional <= nav * 0.10 + 1) ? { status: 'green' } : { status: 'red', reason: `${(notional / nav * 100).toFixed(1)}% > 10%` };
  const riskPct = stop ? (Math.abs(avg - stop) * sh) / nav : 0;
  checks.risk = (riskPct <= 0.015) ? { status: 'green' } : { status: 'yellow', reason: `${(riskPct * 100).toFixed(2)}% NAV` };
  const ord = { red: 3, yellow: 2, green: 1 }; let rollup = 'green'; const reasons = [];
  for (const [k, c] of Object.entries(checks)) { if (ord[c.status] > ord[rollup]) rollup = c.status; if (c.reason) reasons.push(`${k}: ${c.reason}`); }
  return { rollup, checks, reasons };
}

export async function getAmbushPaperPositions() {
  const db = await connectToDatabase();
  if (!db) return [];
  const nav = await getActualNav(db);
  const positions = await db.collection(COLL).find({ status: 'ACTIVE' }).sort({ createdAt: -1 }).toArray();
  return positions.map(p => ({ ...p, rec: verifyAmbushPaperPosition(p, nav) }));
}

export async function getAmbushPaperTrades(limit = 30) {
  const db = await connectToDatabase();
  if (!db) return [];
  return db.collection(TRADES).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

// Clear the paper book (paper only — touches nothing but pnthr_ambush_paper_*).
export async function resetAmbushPaperDryRun() {
  const db = await connectToDatabase();
  if (!db) return { deleted: 0 };
  const r = await db.collection(COLL).deleteMany({ dryRun: true });
  await db.collection(TRADES).deleteMany({ dryRun: true });
  return { deleted: r.deletedCount };
}
