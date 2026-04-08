import express from 'express';
const router = express.Router();
import multer from 'multer';
const { GridFsStorage } = require('multer-gridfs-storage');
const mongoose = require('mongoose');
import DataRoomDocument from '../models/DataRoomDocument.js';

const requireAuth = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!['admin', 'gp'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
};

const storage = new GridFsStorage({
    url: process.env.MONGO_URI,
    options: { useNewUrlParser: true, useUnifiedTopology: true },
        file: (req, file) => ({
              filename: 'dataroom_' + Date.now() + '_' + file.originalname.replace(/\s+/g, '_'),
              bucketName: 'dataroom_files',
        }),
});

const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
              const allowed = ['application/pdf',
                                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                     'image/png', 'image/jpeg'];
              cb(null, allowed.includes(file.mimetype));
        },
});

router.post('/upload', requireAdmin, upload.single('file'), async (req, res) => {
    try {
          if (!req.file) return res.status(400).json({ error: 'No file received' });
          const { title, category, description, version } = req.body;
                if (!title || !category) return res.status(400).json({ error: 'Title and category required' });
                const documentGroup = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          await DataRoomDocument.updateMany({ documentGroup, isLatest: true, deletedAt: null }, { $set: { isLatest: false } });
          const doc = await DataRoomDocument.create({
                  title, category,
                  description: description || '',
                  version: version || 'v1.0',
                  filename: req.file.originalname,
                  gridfsId: req.file.id,
                  fileSize: req.file.size,
                  mimeType: req.file.mimetype,
                  uploadedBy: req.user && req.user.name ? req.user.name : req.user && req.user.email ? req.user.email : 'Admin',
                  uploadedById: req.user ? req.user._id : null,
                  isLatest: true,
                  documentGroup,
          });
          res.json({ success: true, document: doc });
    } catch (err) {
          console.error('DataRoom upload error:', err);
          res.status(500).json({ error: err.message || 'Upload failed' });
    }
});

router.get('/documents', requireAuth, async (req, res) => {
    try {
          const { category, search } = req.query;
          const query = { isLatest: true, deletedAt: null };
          if (category && category !== 'All') query.category = category;
          if (search) query.$or = [{ title: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }];
          const docs = await DataRoomDocument.find(query).sort({ uploadedAt: -1 });
          res.json(docs);
    } catch (err) {
          res.status(500).json({ error: 'Failed to fetch documents' });
    }
});

router.get('/download/:id', requireAuth, async (req, res) => {
    try {
          const doc = await DataRoomDocument.findById(req.params.id);
          if (!doc || doc.deletedAt) return res.status(404).json({ error: 'Not found' });
          const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'dataroom_files' });
          res.setHeader('Content-Disposition', 'attachment; filename="' + doc.filename + '"');
          res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
          bucket.openDownloadStream(doc.gridfsId).pipe(res);
    } catch (err) {
          res.status(500).json({ error: 'Download failed' });
    }
});

router.delete('/documents/:id', requireAdmin, async (req, res) => {
    try {
          const doc = await DataRoomDocument.findById(req.params.id);
          if (!doc) return res.status(404).json({ error: 'Not found' });
          await DataRoomDocument.findByIdAndUpdate(req.params.id, { $set: { deletedAt: new Date() } });
          if (doc.isLatest) {
                  const prior = await DataRoomDocument.findOne({ documentGroup: doc.documentGroup, isLatest: false, deletedAt: null }).sort({ uploadedAt: -1 });
                  if (prior) await DataRoomDocument.findByIdAndUpdate(prior._id, { $set: { isLatest: true } });
          }
          res.json({ success: true });
    } catch (err) {
          res.status(500).json({ error: 'Delete failed' });
    }
});

export default router;
