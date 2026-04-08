import mongoose from 'mongoose';

const schema = new mongoose.Schema({
      label: { type: String, required: true },
      filename: { type: String, required: true },
      contentType: { type: String },
      size: { type: Number },
      data: { type: Buffer },
      section: { type: String, default: 'PNTHR Funds, Carnivore Quant LP Fund Documents' },
      uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      uploadedAt: { type: Date, default: Date.now },
});

export default mongoose.model('DataRoomDocument', schema);
