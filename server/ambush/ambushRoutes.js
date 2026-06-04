// server/ambush/ambushRoutes.js
// ── PNTHR AMBUSH — Express API Routes ───────────────────────────────────────
//
// All routes require admin JWT.
//
// GET  /api/ambush/summary       — full dashboard data (positions, trades, config)
// GET  /api/ambush/positions     — all positions, optionally filtered by ?state=
// GET  /api/ambush/trades        — recent closed trades
// GET  /api/ambush/orders        — recent outbox commands
// POST /api/ambush/config        — update config (enable/disable, NAV, maxPositions)
// POST /api/ambush/tick          — manual trigger of hourly cron tick
// POST /api/ambush/reset         — clear all positions (emergency reset)
// DELETE /api/ambush/position/:ticker — remove a single position
// ────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import fs from 'fs';
import { connectToDatabase, getUserProfile } from '../database.js';
import {
  getAmbushSummary, getAmbushPositions, getAmbushTrades,
  getRecentAmbushOrders, getAmbushConfig, updateAmbushConfig,
  deleteAmbushPosition, ensureAmbushIndexes,
  recordAmbushAum, getAmbushAumSeries,
} from './ambushStateManager.js';
import { runAmbushTick } from './ambushCron.js';
import { getAmbushLiveReconcile } from './ambushLiveReconcile.js';

// ── Projection helpers (Projected vs Actual AUM tracker) ────────────────────
const _projPath = new URL('../data/ambushProjectionBaseline.json', import.meta.url).pathname;
let _projData = null;
function loadProjection() {
  if (!_projData) {
    try { _projData = JSON.parse(fs.readFileSync(_projPath, 'utf8')); }
    catch { _projData = { factors: [], backtestStartNav: 83000, backtestEndNav: 0 }; }
  }
  return _projData;
}
function etDateStr(d = new Date()) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}
function addWeekdays(startISO, n) {
  const d = new Date(startISO + 'T12:00:00');
  let added = 0;
  while (added < n) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) added++; }
  return d.toISOString().split('T')[0];
}
function weekdaysBetween(startISO, endISO) {
  if (!endISO || endISO <= startISO) return 0;
  const e = new Date(endISO + 'T12:00:00'); const d = new Date(startISO + 'T12:00:00');
  let n = 0;
  while (d < e) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

// ── Forward projection ("ride today's edge forward") ────────────────────────
// Replays the V7.4 live withdrawal rule: each trading day, if the working
// balance is at/above $2M, bank $1M and keep trading off the remainder. Growth
// uses the real backtest daily ratios while inside the ~3.5yr backtest window,
// then flat CAGR-per-day beyond it (flagged as extrapolated).
const FWD_WD_THRESHOLD = 2_000_000;
const FWD_WD_AMOUNT    = 1_000_000;
const FWD_HORIZONS = [
  { label: '6 mo',  years: 0.5, days: 126 },
  { label: '1 yr',  years: 1,   days: 252 },
  { label: '18 mo', years: 1.5, days: 378 },
  { label: '2 yr',  years: 2,   days: 504 },
  { label: '3 yr',  years: 3,   days: 756 },
  { label: '5 yr',  years: 5,   days: 1260 },
  { label: '10 yr', years: 10,  days: 2520 },
];
function simulateForward(startBalance, factors, elapsed, dailyCagrRate, horizons) {
  const N = factors.length;
  const maxDays = horizons[horizons.length - 1].days;
  const byDay = new Map(horizons.map(h => [h.days, h]));
  let balance = startBalance;
  let banked = 0;
  const snaps = {};
  for (let k = 1; k <= maxDays; k++) {
    // start-of-day withdrawal check (matches backtest order: bank, then trade)
    if (balance >= FWD_WD_THRESHOLD) { balance -= FWD_WD_AMOUNT; banked += FWD_WD_AMOUNT; }
    const srcIdx = elapsed + k;
    let ratio;
    if (srcIdx < N && factors[srcIdx - 1]?.factor > 0) {
      ratio = factors[srcIdx].factor / factors[srcIdx - 1].factor; // real backtest day
    } else {
      ratio = dailyCagrRate;                                        // beyond backtest
    }
    if (ratio > 0 && isFinite(ratio)) balance *= ratio;
    if (byDay.has(k)) {
      snaps[k] = {
        balance: Math.round(balance),
        banked,
        total: Math.round(balance + banked),
        extrapolated: (elapsed + k) >= N,
      };
    }
  }
  return snaps;
}

export function createAmbushRouter(authenticateJWT, requireAdmin) {
  const router = Router();

  // All Ambush routes require admin
  router.use(authenticateJWT, requireAdmin);

  // GET /api/ambush/summary — full dashboard payload
  router.get('/summary', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const summary = await getAmbushSummary(db);
      res.json(summary);
    } catch (err) {
      console.error('[Ambush API] summary error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ambush/live-reconcile — IBKR-truth verification harness (pills + diag).
  // Per-position green/amber/red checks: direction, shares, avg cost, stop side, stop price,
  // correct 2-bar level, full-position stop quantity, 10% cap, 1%-NAV/$150 risk. Drives the
  // Devour-row pills + the Copy-Diag dump. Independent recompute, so it catches engine errors.
  router.get('/live-reconcile', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const result = await getAmbushLiveReconcile(db);
      res.json(result);
    } catch (err) {
      console.error('[Ambush API] live-reconcile error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ambush/positions — positions with optional state filter
  router.get('/positions', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const state = req.query.state?.toUpperCase() || null;
      const positions = await getAmbushPositions(db, state);
      res.json({ positions, count: positions.length });
    } catch (err) {
      console.error('[Ambush API] positions error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ambush/trades — recent closed trades
  router.get('/trades', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const limit = Math.min(+(req.query.limit || 50), 500);
      const trades = await getAmbushTrades(db, limit);
      res.json({ trades, count: trades.length });
    } catch (err) {
      console.error('[Ambush API] trades error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ambush/orders — recent outbox commands
  router.get('/orders', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const limit = Math.min(+(req.query.limit || 50), 200);
      const orders = await getRecentAmbushOrders(db, limit);
      res.json({ orders, count: orders.length });
    } catch (err) {
      console.error('[Ambush API] orders error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ambush/config — current config
  router.get('/config', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const config = await getAmbushConfig(db);
      res.json(config);
    } catch (err) {
      console.error('[Ambush API] config error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/ambush/config — update config
  router.post('/config', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const updates = {};
      if (req.body.enabled !== undefined) updates.enabled = !!req.body.enabled;
      if (req.body.nav !== undefined) updates.nav = +req.body.nav;
      if (req.body.maxPositions !== undefined) updates.maxPositions = +req.body.maxPositions;
      // Store admin's userId for outbox ownerId (bridge filters by this)
      if (req.user?.userId) updates.ownerId = req.user.userId;

      await updateAmbushConfig(db, updates);
      const config = await getAmbushConfig(db);
      res.json({ ok: true, config });
    } catch (err) {
      console.error('[Ambush API] config update error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/ambush/tick — manual trigger of hourly tick
  router.post('/tick', async (req, res) => {
    try {
      console.log('[Ambush API] Manual tick triggered');
      const result = await runAmbushTick();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[Ambush API] tick error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/ambush/reset — emergency reset (clear all positions)
  router.post('/reset', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const confirm = req.body.confirm;
      if (confirm !== 'RESET_ALL_AMBUSH') {
        return res.status(400).json({ error: 'Must send { confirm: "RESET_ALL_AMBUSH" }' });
      }
      const result = await db.collection('pnthr_ambush_positions').deleteMany({});
      console.log(`[Ambush API] RESET: deleted ${result.deletedCount} positions`);
      res.json({ ok: true, deleted: result.deletedCount });
    } catch (err) {
      console.error('[Ambush API] reset error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ambush/projection — Projected (backtest, pure compounding) vs Actual AUM
  router.get('/projection', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const config = await getAmbushConfig(db);
      const proj = loadProjection();
      const factors = proj.factors || [];

      // Current actual NAV (IBKR-synced accountSize -> config.nav -> $83k)
      let actualNav = config.nav || 83000;
      if (config.ownerId) {
        try { const p = await getUserProfile(config.ownerId); if (p?.accountSize > 0) actualNav = p.accountSize; } catch {}
      }
      const todayISO = etDateStr();

      // Anchor: lock the projection start (date + AUM) on first call.
      let projectionStartDate = config.projectionStartDate;
      let projectionStartAum = config.projectionStartAum;
      if (!projectionStartDate || !projectionStartAum) {
        projectionStartDate = todayISO;
        projectionStartAum = actualNav;
        await updateAmbushConfig(db, { projectionStartDate, projectionStartAum });
      }

      // Record today's actual snapshot, then read the actual series.
      await recordAmbushAum(db, todayISO, actualNav);
      const actualSeries = await getAmbushAumSeries(db);

      // Projected forward curve: backtest growth factor x anchor AUM, mapped to weekday
      // dates. Uses the full backtest (~3.5 years); no extrapolation beyond the data.
      const N = factors.length;
      const dates = N ? [projectionStartDate] : [];
      {
        const d = new Date(projectionStartDate + 'T12:00:00');
        for (let i = 1; i < N; i++) {
          do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
          dates.push(d.toISOString().split('T')[0]);
        }
      }
      const projected = factors.map((f, i) => ({
        date: dates[i],
        value: +(projectionStartAum * f.factor).toFixed(0),
      }));

      const elapsed = Math.min(weekdaysBetween(projectionStartDate, todayISO), Math.max(0, N - 1));
      const projectedToday = +(projectionStartAum * (factors[elapsed]?.factor || 1)).toFixed(0);
      const onTrackPct = projectedToday > 0 ? +(((actualNav / projectedToday) - 1) * 100).toFixed(1) : 0;

      // Forward projection: ride today's projected baseline AND today's real AUM
      // forward, applying the $2M -> bank $1M withdrawal rule, at 6mo .. 10yr.
      const cagrPct = proj.metrics?.cagrPct || 0;
      const dailyCagr = cagrPct > 0 ? Math.pow(1 + cagrPct / 100, 1 / 252) : 1;
      const projFwd = N ? simulateForward(projectedToday, factors, elapsed, dailyCagr, FWD_HORIZONS) : {};
      const actFwd  = N ? simulateForward(actualNav,      factors, elapsed, dailyCagr, FWD_HORIZONS) : {};
      const forward = {
        cagrPct,
        withdrawalRule: { threshold: FWD_WD_THRESHOLD, amount: FWD_WD_AMOUNT },
        horizons: FWD_HORIZONS.map(h => ({
          label: h.label, years: h.years, days: h.days,
          projected: projFwd[h.days] || null,
          actual: actFwd[h.days] || null,
          extrapolated: (actFwd[h.days]?.extrapolated) || false,
        })),
      };

      res.json({
        anchor: { startDate: projectionStartDate, startAum: +projectionStartAum.toFixed(0) },
        current: { date: todayISO, projectedAum: projectedToday, actualAum: +(+actualNav).toFixed(0), onTrackPct },
        projected,
        actual: actualSeries.map(s => ({ date: s.date, value: s.actualAum })),
        forward,
        metrics: proj.metrics || null,
        meta: { backtestEndNav: proj.backtestEndNav, tradingDays: factors.length, basis: 'pure compounding (no withdrawals)' },
      });
    } catch (err) {
      console.error('[Ambush API] projection error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/ambush/position/:ticker — remove a single position
  router.delete('/position/:ticker', async (req, res) => {
    try {
      const db = await connectToDatabase();
      const ticker = req.params.ticker.toUpperCase();
      await deleteAmbushPosition(db, ticker);
      res.json({ ok: true, ticker });
    } catch (err) {
      console.error('[Ambush API] delete position error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
