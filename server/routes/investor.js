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
  addNote,
  getNotes,
  updateNote,
  deleteNote,
  resetLoginCount,
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
    if (!investor) return res.status(401).json({ error: 'Invalid credentials' });
    if (investor.locked) return res.status(403).json({ error: investor.reason });

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
        investmentAmount: investor.investmentAmount || null,
        loginCount: (investor.loginCount || 0) + 1, // already incremented
        maxLogins: investor.maxLogins || 5,
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

// POST /api/investors/:id/reset-logins — reset login count to 0
investorAdminRouter.post('/:id/reset-logins', async (req, res) => {
  try {
    await resetLoginCount(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/investors/:id/notes — get all notes for an investor
investorAdminRouter.get('/:id/notes', async (req, res) => {
  try {
    const notes = await getNotes(req.params.id);
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/investors/:id/notes — add a note
investorAdminRouter.post('/:id/notes', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Note text required' });
    const note = await addNote(req.params.id, text.trim(), req.user.email);
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/investors/notes/:noteId — edit a note
investorAdminRouter.patch('/notes/:noteId', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Note text required' });
    await updateNote(req.params.noteId, text.trim());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/investors/notes/:noteId — delete a note
investorAdminRouter.delete('/notes/:noteId', async (req, res) => {
  try {
    await deleteNote(req.params.noteId);
    res.json({ success: true });
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
      investmentAmount: investor.investmentAmount || null,
      loginCount: investor.loginCount || 0,
      maxLogins: investor.maxLogins || 5,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/investor/investment-amount — set/update investment amount + auto-note to admin
investorSelfRouter.post('/investment-amount', async (req, res) => {
  try {
    if (req.user.role !== 'investor') return res.status(403).json({ error: 'Investor access only' });
    const { amount } = req.body;
    if (!amount || typeof amount !== 'number') return res.status(400).json({ error: 'Valid amount required' });

    // Get current amount for change note
    const investor = await findInvestorById(req.user.userId);
    const prevAmount = investor?.investmentAmount;

    // Update investor profile
    await updateInvestor(req.user.userId, { investmentAmount: amount });

    // Auto-note to admin
    const fmt = (v) => '$' + v.toLocaleString();
    const noteText = prevAmount
      ? `Investor changed investment amount from ${fmt(prevAmount)} to ${fmt(amount)}`
      : `Investor selected ${fmt(amount)} investment amount`;
    await addNote(req.user.userId, noteText, 'system');

    res.json({ success: true, investmentAmount: amount });
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
