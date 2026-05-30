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
import { connectToDatabase } from '../database.js';
import {
  getAmbushSummary, getAmbushPositions, getAmbushTrades,
  getRecentAmbushOrders, getAmbushConfig, updateAmbushConfig,
  deleteAmbushPosition, ensureAmbushIndexes,
} from './ambushStateManager.js';
import { runAmbushTick } from './ambushCron.js';

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
