import express from 'express';
import multer from 'multer';
import DataRoomDocument from '../models/DataRoomDocument.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// All routes already sit behind authenticateJWT from index.js, so req.user is set.

// GET /api/dataroom — list all documents (exclude raw data from listing)
router.get('/', async (req, res) => {
  try {
    const docs = await DataRoomDocument.find({}, { data: 0 }).sort({ uploadedAt: -1 });
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
    const doc = await DataRoomDocument.create({
      label: req.body.label || req.file.originalname,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
      uploadedBy: req.user.userId,
    });
    res.json({ _id: doc._id, label: doc.label, filename: doc.filename, size: doc.size, uploadedAt: doc.uploadedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dataroom/:id/download — download a document
router.get('/:id/download', async (req, res) => {
  try {
    const doc = await DataRoomDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.set('Content-Type', doc.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.send(doc.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dataroom/:id — delete a document (admin only)
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const doc = await DataRoomDocument.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
