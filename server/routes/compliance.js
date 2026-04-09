import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../database.js';
import { resolveRole } from '../auth.js';
import archiver from 'archiver';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const DOCS_COLLECTION = 'compliance_documents';
const TASKS_COLLECTION = 'compliance_tasks';
const SECTIONS_COLLECTION = 'compliance_sections';

const SEED_CATEGORIES = [
  'Quarterly Compliance Reviews',
  'Policies & Procedures',
  'Code of Ethics',
  'Business Continuity (BCDRP)',
  'Regulatory Filings',
  'Disclosures & Website',
  'Onboarding & Reference',
  'Receipts',
];

// ── Middleware: require admin for ALL compliance routes ──────────────────────
// Also supports ?token= query param for new-tab viewing (Authorization header not available)
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

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/compliance/documents — list all documents (exclude raw data)
router.get('/documents', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const docs = await db.collection(DOCS_COLLECTION)
      .find({}, { projection: { data: 0 } })
      .sort({ category: 1, subcategory: 1, uploadedAt: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/compliance/categories — list all categories (seed + custom + from docs)
router.get('/categories', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const fromDocs = await db.collection(DOCS_COLLECTION).distinct('category');
    const custom = await db.collection(SECTIONS_COLLECTION).find({}).toArray();
    const customNames = custom.map(s => s.name);
    const all = [...new Set([...SEED_CATEGORIES, ...fromDocs.filter(Boolean), ...customNames])].sort();
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/compliance/categories — create a new category
router.post('/categories', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Category name required' });
    const db = await connectToDatabase();
    await db.collection(SECTIONS_COLLECTION).updateOne(
      { name: name.trim() },
      { $set: { name: name.trim(), createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/compliance/upload — upload a document
router.post('/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const db = await connectToDatabase();
    const doc = {
      label: req.body.label || req.file.originalname,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
      category: req.body.category || SEED_CATEGORIES[0],
      subcategory: req.body.subcategory || '',
      uploadedBy: req.user.userId,
      uploadedAt: new Date(),
    };
    const result = await db.collection(DOCS_COLLECTION).insertOne(doc);
    res.json({ _id: result.insertedId, label: doc.label, filename: doc.filename, size: doc.size, category: doc.category, subcategory: doc.subcategory, uploadedAt: doc.uploadedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/compliance/documents/:id/view — view inline (supports ?token= for new-tab)
router.get('/documents/:id/view', async (req, res) => {
  try {
    // Already admin-verified by middleware, but also support token query param for new-tab
    const db = await connectToDatabase();
    const doc = await db.collection(DOCS_COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.set('Content-Type', doc.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.send(doc.data.buffer || doc.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/compliance/documents/:id/download — download a document
router.get('/documents/:id/download', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const doc = await db.collection(DOCS_COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.set('Content-Type', doc.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.send(doc.data.buffer || doc.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/compliance/download-all — download all (or by category) as zip
router.get('/download-all', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const filter = req.query.category ? { category: req.query.category } : {};
    const docs = await db.collection(DOCS_COLLECTION).find(filter).toArray();
    if (docs.length === 0) return res.status(404).json({ error: 'No documents found' });

    const zipName = req.query.category
      ? `PNTHR_Compliance_${req.query.category.replace(/[^a-zA-Z0-9]/g, '_')}.zip`
      : 'PNTHR_Compliance_All_Documents.zip';

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    for (const doc of docs) {
      const buf = doc.data.buffer || doc.data;
      const folder = (doc.category || 'Uncategorized').replace(/[/\\]/g, '_');
      const sub = doc.subcategory ? `/${doc.subcategory.replace(/[/\\]/g, '_')}` : '';
      archive.append(Buffer.from(buf), { name: `${folder}${sub}/${doc.filename}` });
    }

    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// DELETE /api/compliance/documents/:id — delete a document
router.delete('/documents/:id', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const result = await db.collection(DOCS_COLLECTION).deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Document not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS (Phase 1: basic CRUD)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/compliance/tasks — list all tasks
router.get('/tasks', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const tasks = await db.collection(TASKS_COLLECTION)
      .find({})
      .sort({ dueDate: 1 })
      .toArray();
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/compliance/tasks — create a task
router.post('/tasks', async (req, res) => {
  try {
    const { title, description, dueDate, recurrence, category, linkedDocId } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Task title required' });
    if (!dueDate) return res.status(400).json({ error: 'Due date required' });
    const db = await connectToDatabase();
    const task = {
      title: title.trim(),
      description: description?.trim() || '',
      dueDate: new Date(dueDate),
      recurrence: recurrence || 'one-time', // one-time, quarterly, annual
      category: category || '',
      status: 'UPCOMING', // UPCOMING, DUE_SOON, OVERDUE, COMPLETED
      completedAt: null,
      linkedDocId: linkedDocId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection(TASKS_COLLECTION).insertOne(task);
    res.json({ ...task, _id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/compliance/tasks/:id — update a task (status, link doc, edit fields)
router.patch('/tasks/:id', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const updates = { ...req.body, updatedAt: new Date() };

    // If marking complete, set completedAt and auto-generate next recurrence
    if (updates.status === 'COMPLETED' && !updates.completedAt) {
      updates.completedAt = new Date();
    }

    // Convert dueDate string to Date object if provided
    if (updates.dueDate) updates.dueDate = new Date(updates.dueDate);

    const result = await db.collection(TASKS_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updates },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Task not found' });

    // Auto-generate next recurring task if completed and recurring
    const task = result;
    if (updates.status === 'COMPLETED' && task.recurrence && task.recurrence !== 'one-time') {
      const nextDue = new Date(task.dueDate);
      if (task.recurrence === 'quarterly') nextDue.setMonth(nextDue.getMonth() + 3);
      else if (task.recurrence === 'annual') nextDue.setFullYear(nextDue.getFullYear() + 1);
      else if (task.recurrence === 'monthly') nextDue.setMonth(nextDue.getMonth() + 1);

      await db.collection(TASKS_COLLECTION).insertOne({
        title: task.title,
        description: task.description,
        dueDate: nextDue,
        recurrence: task.recurrence,
        category: task.category,
        status: 'UPCOMING',
        completedAt: null,
        linkedDocId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/compliance/tasks/:id — delete a task
router.delete('/tasks/:id', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const result = await db.collection(TASKS_COLLECTION).deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
