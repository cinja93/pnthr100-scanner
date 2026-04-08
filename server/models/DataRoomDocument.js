import mongoose from 'mongoose';

const DataRoomDocumentSchema = new mongoose.Schema({
    title:         { type: String, required: true },
    category:      { type: String, required: true, enum: ['Fund Formation', 'Offering Documents', 'Tax & Compliance', 'Investor Reports', 'Legal Agreements', 'Regulatory Filings', 'Other'] },
    description:   { type: String, default: '' },
    version:       { type: String, default: 'v1.0' },
    filename:      { type: String, required: true },
    gridfsId:      { type: mongoose.Schema.Types.ObjectId },
    fileSize:      { type: Number },
    mimeType:      { type: String },
    uploadedBy:    { type: String, default: 'Admin' },
    uploadedById:  { type: mongoose.Schema.Types.ObjectId },
    uploadedAt:    { type: Date, default: Date.now },
    isLatest:      { type: Boolean, default: true },
    documentGroup: { type: String },
    deletedAt:     { type: Date, default: null },
}, { timestamps: true });

DataRoomDocumentSchema.index({ isLatest: 1, deletedAt: 1 });
DataRoomDocumentSchema.index({ documentGroup: 1 });

export default mongoose.model('DataRoomDocument', DataRoomDocumentSchema);
