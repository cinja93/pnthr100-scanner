import express from 'express';
import multer from 'multer';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../database.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const COLLECTION = 'dataroom_documents';

// GET /api/dataroom — list all documents (exclude raw data from listing)
router.get('/', async (req, res) => {
  try {
    const db = await connectToDatabase();
    const docs = await db.collection(COLLECTION)
      .find({}, { projection: { data: 0 } })
      .sort({ uploadedAt: -1 })
      .toArray();
    res.json(docs);
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
    const doc = {
      label: req.body.label || req.file.originalname,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
      uploadedBy: req.user.userId,
      uploadedAt: new Date(),
    };
    const result = await db.collection(COLLECTION).insertOne(doc);
    res.json({ _id: result.insertedId, label: doc.label, filename: doc.filename, size: doc.size, uploadedAt: doc.uploadedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dataroom/:id/download — download a document
router.get('/:id/download', async (req, res) => {
  try {
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
