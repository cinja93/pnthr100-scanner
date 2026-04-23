// server/routes/newsletter.js
import { Router } from 'express';
import { authenticateJWT, requireAdmin } from '../auth.js';
import {
  listIssues,
  getIssue,
  updateIssueNarrative,
  publishIssue,
  getMostRecentFriday,
} from '../newsletterService.js';
import { generatePerch } from '../perchService.js';
import { connectToDatabase } from '../database.js';

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

// POST /api/newsletter/generate -- ADMIN ONLY
// Uses perchService v3: MongoDB Kill scores, regime, signal_history, trade archive
router.post('/generate', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const db = await connectToDatabase();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    console.log('[Newsletter] Generating Perch v3 issue...');
    const { narrative, wasTruncated, metadata, blacklistViolations, charts } = await generatePerch(db);
    const weekOf = req.body.weekOf || metadata.weekOf || getMostRecentFriday();

    // Save to newsletter_issues (same collection -- frontend unchanged)
    const col = db.collection('newsletter_issues');
    const existing = await col.findOne({ weekOf });
    const doc = {
      weekOf,
      status: 'draft',
      narrative,
      generatedAt: new Date(),
      generatorVersion: 'perch-v3',
      metadata,
      // Precomputed chart data used by NewsPage.jsx to render inline panels
      // (e.g. the week-over-week sector rotation bars) alongside the narrative.
      ...(charts && { charts }),
      ...(wasTruncated && { wasTruncated: true }),
      ...(blacklistViolations.length > 0 && { blacklistViolations }),
    };

    if (existing) {
      await col.updateOne({ weekOf }, { $set: doc });
      const result = { ...existing, ...doc, _id: existing._id };
      if (wasTruncated) result.warning = '⚠ Newsletter was truncated — generation hit token limit. Content may be incomplete.';
      return res.json(result);
    }
    const result = await col.insertOne(doc);
    const response = { ...doc, _id: result.insertedId };
    if (wasTruncated) response.warning = '⚠ Newsletter was truncated — generation hit token limit. Content may be incomplete.';
    res.json(response);
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
