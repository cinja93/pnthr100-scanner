// PNTHR Accounting — admin-only routes (INTERNAL).
//
// Serves the monthly placeholder grid + view/download of the generated
// fund-accounting documents. Mounted behind authenticateJWT in index.js; this
// router additionally enforces admin (these are internal fund-ops documents,
// never investor-visible from here). Supports ?token= for new-tab PDF/Excel opens
// where the Authorization header isn't available — same pattern as the data room.

import express from 'express';
import jwt from 'jsonwebtoken';
import { resolveRole } from '../auth.js';
import { listPeriods, getDocument, ensurePeriods, listReferenceDocuments } from '../pnthrAccountingService.js';
import { buildAuditPackageZip, buildK1DataPackage } from '../pnthrAccountingPackages.js';

const router = express.Router();

// Admin guard for the whole router (with ?token= fallback for new-tab opens).
router.use((req, res, next) => {
  if (!req.user && req.query.token) {
    try {
      const payload = jwt.verify(req.query.token, process.env.JWT_SECRET);
      req.user = { userId: payload.userId, email: payload.email, role: resolveRole(payload.email) };
    } catch { /* invalid token */ }
  }
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
});

// GET /api/pnthr-accounting/periods — the 24 monthly buckets + which docs each holds.
router.get('/periods', async (req, res) => {
  try {
    const result = await listPeriods();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pnthr-accounting/ensure-periods — manually (re)seed missing month buckets.
router.post('/ensure-periods', async (req, res) => {
  try {
    const created = await ensurePeriods();
    res.json({ created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pnthr-accounting/reference — fund-level reference documents (not period-bound).
router.get('/reference', async (req, res) => {
  try {
    res.json(await listReferenceDocuments());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pnthr-accounting/documents/:id/view — inline view (PDF/Excel).
router.get('/documents/:id/view', async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.set('Content-Type', doc.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.send(doc.data?.buffer || doc.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pnthr-accounting/documents/:id/download — download attachment.
router.get('/documents/:id/download', async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.set('Content-Type', doc.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.send(doc.data?.buffer || doc.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pnthr-accounting/audit-package/:year — one-button auditor package (zip).
router.get('/audit-package/:year', async (req, res) => {
  try {
    const year = parseInt(req.params.year, 10);
    if (!(year >= 2025 && year <= 2100)) return res.status(400).json({ error: 'bad year' });
    const zipBuf = await buildAuditPackageZip(year);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="PNTHR_Audit_Package_${year}.zip"`);
    res.send(zipBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pnthr-accounting/k1-package/:year/:investorNo — per-investor K-1 tax data package (PDF).
router.get('/k1-package/:year/:investorNo', async (req, res) => {
  try {
    const year = parseInt(req.params.year, 10);
    if (!(year >= 2025 && year <= 2100)) return res.status(400).json({ error: 'bad year' });
    const pdf = await buildK1DataPackage(year, req.params.investorNo);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="PNTHR_K1_DataPackage_${year}_Investor${req.params.investorNo}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
