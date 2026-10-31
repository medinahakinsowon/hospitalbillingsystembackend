import mongoose from 'mongoose';
const { Schema } = mongoose;

const tariffSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, maxlength: 300 },
    isDefault: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
tariffSchema.index({ code: 1 }, { unique: true });
// At most one default tariff (used when a payer has none, or the payer's tariff lacks a price).
tariffSchema.index({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

export const Tariff = mongoose.model('Tariff', tariffSchema);
