import mongoose from 'mongoose';
const { Schema } = mongoose;

// Money handed back to a payer from credit they hold (an unused deposit, an overpayment, or credit released by a credit note).
const refundSchema = new Schema(
  {
    refundNo: { type: String, required: true },
    payerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true }, // the payment whose unallocated credit is returned
    amountKobo: { type: Number, required: true, min: 1, validate: { validator: Number.isSafeInteger, message: 'must be an integer number of kobo' } },
    method: { type: String, enum: ['cash', 'transfer'], required: true },
    reason: { type: String, required: true, minlength: 5, maxlength: 200 },
    // pending -> approved (funds reserved in the ledger) -> paid (cash/transfer handed over)
    status: { type: String, enum: ['pending', 'approved', 'paid', 'rejected', 'cancelled'], default: 'pending' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: { type: String, maxlength: 300 },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paidAt: Date,
    payoutRef: { type: String, maxlength: 80 },
    paidSessionId: { type: Schema.Types.ObjectId, ref: 'CashierSession' }, // the till shift that handed the money out
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: 'LedgerEntry' },
  },
  { timestamps: true }
);
refundSchema.index({ refundNo: 1 }, { unique: true });
refundSchema.index({ payerId: 1, status: 1, createdAt: -1 });
refundSchema.index({ paymentId: 1, status: 1 });
refundSchema.index({ status: 1, createdAt: -1 });

export const Refund = mongoose.model('Refund', refundSchema);
