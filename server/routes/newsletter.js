// server/routes/newsletter.js
import { Router } from 'express';
import { authenticateJWT, requireAdmin } from '../auth.js';
import {
  generateIssue,
  listIssues,
  getIssue,
  updateIssueNarrative,
  publishIssue,
  getMostRecentFriday,
} from '../newsletterService.js';

const router = Router();

// GET /api/newsletter — list all issues (any authenticated user can view)
router.get('/', async (req, res) => {
  try {
    const issues = await listIssues();
    res.json(issues);
  } catch (err) {
    console.error('Newsletter list error:', err);
    res.status(500).json({ error: 'Failed to list newsletter issues' });
  }
});

// GET /api/newsletter/:id — get full issue (any authenticated user can read)
router.get('/:id', async (req, res) => {
  try {
    const issue = await getIssue(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    res.json(issue);
  } catch (err) {
    console.error('Newsletter get error:', err);
    res.status(500).json({ error: 'Failed to get newsletter issue' });
  }
});

// POST /api/newsletter/generate — ADMIN ONLY
router.post('/generate', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const weekOf = req.body.weekOf || getMostRecentFriday();
    console.log(`[Newsletter] Generating issue for week of ${weekOf}...`);
    const issue = await generateIssue(weekOf);
    res.json(issue);
  } catch (err) {
    console.error('Newsletter generate error:', err);
    res.status(500).json({ error: 'Failed to generate newsletter: ' + err.message });
  }
});

// PATCH /api/newsletter/:id — ADMIN ONLY (edit narrative)
router.patch('/:id', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const { narrative } = req.body;
    if (!narrative) return res.status(400).json({ error: 'narrative is required' });
    await updateIssueNarrative(req.params.id, narrative);
    res.json({ ok: true });
  } catch (err) {
    console.error('Newsletter update error:', err);
    res.status(500).json({ error: 'Failed to update newsletter issue' });
  }
});

// POST /api/newsletter/:id/publish — ADMIN ONLY
router.post('/:id/publish', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    await publishIssue(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Newsletter publish error:', err);
    res.status(500).json({ error: 'Failed to publish newsletter issue' });
  }
});

export default router;
