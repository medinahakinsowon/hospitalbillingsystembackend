import mongoose from 'mongoose';
const { Schema } = mongoose;

// Discounts, waivers, credit notes and write-offs against an issued invoice.
// Always requested by one person and approved by another (maker-checker); nothing changes until approval.
const adjustmentSchema = new Schema(
  {
    adjNo: { type: String, required: true },
    creditNoteNo: String, // assigned when applied (gap-free)
    kind: { type: String, enum: ['discount', 'waiver', 'credit_note', 'writeoff'], required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    invoiceNo: String,
    payerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    amountKobo: { type: Number, min: 0, validate: { validator: Number.isSafeInteger, message: 'must be an integer number of kobo' } }, // as requested; recomputed on apply for waivers and credit notes
    appliedKobo: { type: Number, min: 0 },
    percent: { type: Number, min: 1, max: 100 },
    chargeIds: [{ type: Schema.Types.ObjectId, ref: 'Charge' }], // credit notes: the charges being credited
    reason: { type: String, required: true, minlength: 5, maxlength: 200 },
    status: { type: String, enum: ['pending', 'applied', 'rejected', 'cancelled'], default: 'pending' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: { type: String, maxlength: 300 },
    releasedToCreditKobo: { type: Number, default: 0 }, // part of a credit on an already-paid invoice that went back to the payer as held credit
  },
  { timestamps: true }
);
adjustmentSchema.index({ adjNo: 1 }, { unique: true });
adjustmentSchema.index({ creditNoteNo: 1 }, { unique: true, partialFilterExpression: { creditNoteNo: { $type: 'string' } } });
adjustmentSchema.index({ invoiceId: 1, status: 1 });
adjustmentSchema.index({ status: 1, createdAt: -1 });

export const Adjustment = mongoose.model('Adjustment', adjustmentSchema);
