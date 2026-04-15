/**
 * investor.js — Express routes for investor portal
 *
 * Two route groups:
 *   /api/investors/*   — admin-only management (list, create, update, delete, analytics)
 *   /api/investor/*    — investor self-service (profile, events, data room)
 *   /auth/investor/*   — unauthenticated login endpoint
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import {
  createInvestor,
  findInvestorById,
  listInvestors,
  updateInvestor,
  deleteInvestor,
  authenticateInvestor,
  logEvent,
  getInvestorActivity,
  getAnalyticsSummary,
} from '../investorService.js';

const JWT_SECRET = process.env.JWT_SECRET;

// ── Helper: generate investor JWT ───────────────────────────────────────────

function generateInvestorToken(investorId, email) {
  return jwt.sign(
    { userId: investorId.toString(), email, role: 'investor', source: 'den_investors' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH (unauthenticated)
// ══════════════════════════════════════════════════════════════════════════════

export const investorAuthRouter = express.Router();

// POST /auth/investor/login
investorAuthRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const investor = await authenticateInvestor(email, password);
    if (!investor) return res.status(401).json({ error: 'Invalid credentials or account disabled' });

    const token = generateInvestorToken(investor._id, investor.email);

    // Log session start
    await logEvent(investor._id, 'session_start', {}, req);

    res.json({
      token,
      email: investor.email,
      role: 'investor',
      profile: {
        name: investor.name,
        company: investor.company,
        email: investor.email,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN MANAGEMENT (requires admin role)
// ══════════════════════════════════════════════════════════════════════════════

export const investorAdminRouter = express.Router();

// GET /api/investors — list all investors
investorAdminRouter.get('/', async (req, res) => {
  try {
    const investors = await listInvestors();
    res.json(investors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/investors — create investor account
investorAdminRouter.post('/', async (req, res) => {
  try {
    const { name, email, company, password, dataroomSections } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    const investor = await createInvestor({
      name, email, company, password, dataroomSections,
      createdBy: req.user.userId,
    });
    res.json(investor);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Investor with this email already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/investors/:id — update investor
investorAdminRouter.patch('/:id', async (req, res) => {
  try {
    await updateInvestor(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/investors/:id — delete investor
investorAdminRouter.delete('/:id', async (req, res) => {
  try {
    await deleteInvestor(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/investors/:id/activity — activity log for one investor
investorAdminRouter.get('/:id/activity', async (req, res) => {
  try {
    const activity = await getInvestorActivity(req.params.id);
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/investors/analytics — aggregate analytics
investorAdminRouter.get('/analytics', async (req, res) => {
  try {
    const summary = await getAnalyticsSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INVESTOR SELF-SERVICE (requires investor role)
// ══════════════════════════════════════════════════════════════════════════════

export const investorSelfRouter = express.Router();

// GET /api/investor/profile — investor's own profile
investorSelfRouter.get('/profile', async (req, res) => {
  try {
    if (req.user.role !== 'investor') return res.status(403).json({ error: 'Investor access only' });
    const investor = await findInvestorById(req.user.userId);
    if (!investor) return res.status(404).json({ error: 'Investor not found' });
    res.json({
      name: investor.name,
      email: investor.email,
      company: investor.company,
      role: 'investor',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/investor/events — log an event (page view, doc view, etc.)
investorSelfRouter.post('/events', async (req, res) => {
  try {
    if (req.user.role !== 'investor') return res.status(403).json({ error: 'Investor access only' });
    const { type, page, documentId, documentName, extra } = req.body;
    if (!type) return res.status(400).json({ error: 'Event type required' });
    await logEvent(req.user.userId, type, { page, documentId, documentName, extra }, req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
