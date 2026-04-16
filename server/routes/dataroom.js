import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../database.js';
import { resolveRole } from '../auth.js';
import archiver from 'archiver';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const COLLECTION = 'dataroom_documents';
const DEFAULT_SECTION = 'PNTHR Funds, Carnivore Quant LP Fund Documents';
const SEED_SECTIONS = [DEFAULT_SECTION, 'Supporting PNTHR Documents'];

// GET /api/dataroom — list all documents (exclude raw data from listing)
router.get('/', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const docs = await db.collection(COLLECTION)
      .find({}, { projection: { data: 0 } })
      .sort({ section: 1, sortOrder: 1, uploadedAt: -1 })
      .toArray();
    // Backfill section for legacy docs
    const filled = docs.map(d => ({ ...d, section: d.section || DEFAULT_SECTION }));
    res.json(filled);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dataroom/sections — list distinct section names
router.get('/sections', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const sections = await db.collection(COLLECTION).distinct('section');
    // Also check for a dedicated sections collection for pre-created empty sections
    const custom = await db.collection('dataroom_sections').find({}).toArray();
    const customNames = custom.map(s => s.name);
    const all = [...new Set([...sections.filter(Boolean), ...customNames, ...SEED_SECTIONS])].sort();
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dataroom/sections — create a new named section (admin only)
router.post('/sections', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Section name required' });
    const db = await connectToDatabase();
    await db.collection('dataroom_sections').updateOne(
      { name: name.trim() },
      { $set: { name: name.trim(), createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dataroom/upload — upload a document (admin only)
router.post('/upload', upload.single('document'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const db = await connectToDatabase();
    const section = req.body.section || DEFAULT_SECTION;
    // Set sortOrder to append after existing docs in this section
    const maxDoc = await db.collection(COLLECTION).find({ section }).sort({ sortOrder: -1 }).limit(1).toArray();
    const nextOrder = (maxDoc[0]?.sortOrder ?? -1) + 1;
    const doc = {
      label: req.body.label || req.file.originalname,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
      section,
      sortOrder: nextOrder,
      uploadedBy: req.user.userId,
      uploadedAt: new Date(),
    };
    const result = await db.collection(COLLECTION).insertOne(doc);
    res.json({ _id: result.insertedId, label: doc.label, filename: doc.filename, size: doc.size, section: doc.section, uploadedAt: doc.uploadedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dataroom/download-all — download all docs (or by section) as zip (admin only)
router.get('/download-all', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const db = await connectToDatabase();
    const filter = req.query.section ? { section: req.query.section } : {};
    const docs = await db.collection(COLLECTION).find(filter).toArray();
    if (docs.length === 0) return res.status(404).json({ error: 'No documents found' });

    const zipName = req.query.section
      ? `PNTHR_DataRoom_${req.query.section.replace(/[^a-zA-Z0-9]/g, '_')}.zip`
      : 'PNTHR_DataRoom_All_Documents.zip';

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    for (const doc of docs) {
      const buf = doc.data.buffer || doc.data;
      const folder = (doc.section || DEFAULT_SECTION).replace(/[/\\]/g, '_');
      archive.append(Buffer.from(buf), { name: `${folder}/${doc.filename}` });
    }

    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /api/dataroom/:id/view — view a document inline (all authenticated users)
// Supports ?token= query param for new-tab viewing (Authorization header not available)
router.get('/:id/view', async (req, res) => {
  try {
    // Auth: prefer header, fall back to query param token (for new-tab opens)
    let user = req.user;
    let isInvestor = user?.source === 'den_investors';
    if (!user && req.query.token) {
      try {
        const payload = jwt.verify(req.query.token, process.env.JWT_SECRET);
        isInvestor = payload.source === 'den_investors';
        user = { userId: payload.userId, email: payload.email, role: isInvestor ? 'investor' : resolveRole(payload.email), source: payload.source };
      } catch { /* invalid token */ }
    }
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const db = await connectToDatabase();
    const doc = await db.collection(COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Log view for investors and track in event log (non-blocking)
    const investorDetected = isInvestor || user?.role === 'investor' || user?.isInvestor;
    if (investorDetected) {
      (async () => {
        try {
          const inv = await db.collection('den_investors').findOne({ _id: new ObjectId(user.userId) }, { projection: { name: 1 } });
          await db.collection('dataroom_view_log').insertOne({
            investorId: user.userId,
            investorEmail: user.email,
            investorName: inv?.name || null,
            documentId: new ObjectId(req.params.id),
            documentName: doc.label || doc.filename,
            section: doc.section || DEFAULT_SECTION,
            viewedAt: new Date(),
          });
          console.log(`[DataRoom] Logged view: ${user.email} → ${doc.label || doc.filename}`);
        } catch (err) { console.error('[DataRoom] View log error:', err.message); }
      })();
    }

    res.set('Content-Type', doc.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.send(doc.data.buffer || doc.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dataroom/:id/download — download a document (admin only)
router.get('/:id/download', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required — documents are view-only for members' });
    const db = await connectToDatabase();
    const doc = await db.collection(COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.set('Content-Type', doc.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.send(doc.data.buffer || doc.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/dataroom/reorder — reorder documents within a section (admin only)
router.patch('/reorder', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { order } = req.body; // [{ id, sortOrder }]
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    const db = await connectToDatabase();
    const ops = order.map(({ id, sortOrder }) => ({
      updateOne: { filter: { _id: new ObjectId(id) }, update: { $set: { sortOrder } } }
    }));
    if (ops.length > 0) await db.collection(COLLECTION).bulkWrite(ops);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dataroom/view-log — investor document view log (admin only)
router.get('/view-log', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const db = await connectToDatabase();
    const logs = await db.collection('dataroom_view_log')
      .find({})
      .sort({ viewedAt: -1 })
      .limit(200)
      .toArray();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dataroom/:id — delete a document (admin only)
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Document not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
