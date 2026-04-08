import express from 'express';
import multer from 'multer';
import DataRoomDocument from '../models/DataRoomDocument.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const requireAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
};

// GET /api/dataroom — list all documents
router.get('/', requireAuth, async (req, res) => {
  try {
    const docs = await DataRoomDocument.find().sort({ uploadedAt: -1 });
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dataroom/upload — upload a document (admin only)
router.post('/upload', requireAuth, requireAdmin, upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const doc = await DataRoomDocument.create({
      label: req.body.label || req.file.originalname,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
cat > /Users/cindyeagar/pnthr100-scanner/server/models/DataRoomDocument.js << 'EOF'
import mongoose from 'mongoose';

const DataRoomDocumentSchema = new mongoose.Schema({
  label: { type: String, required: true },
  filename: { type: String, required: true },
  contentType: { type: String },
  size: { type: Number },
  data: { type: Buffer },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  uploadedAt: { type: Date, default: Date.now },
});

export default mongoose.model('DataRoomDocument', DataRoomDocumentSchema);
