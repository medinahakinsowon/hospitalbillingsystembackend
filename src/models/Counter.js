import mongoose from 'mongoose';
const counterSchema = new mongoose.Schema({ _id: { type: String }, seq: { type: Number, default: 0 } }, { versionKey: false });
export const Counter = mongoose.model('Counter', counterSchema);
