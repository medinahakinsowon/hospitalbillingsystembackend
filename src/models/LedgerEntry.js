import mongoose from 'mongoose';
import { appendOnly } from './appendOnly.js';
const { Schema } = mongoose;

const ledgerEntrySchema = new Schema(
  {
    payerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    seq: { type: Number, required: true }, // per-payer, gap-free, assigned atomically
    type: { type: String, enum: ['charge', 'payment', 'refund', 'adjustment', 'writeoff', 'reversal'], required: true },
    // Signed integer kobo: positive increases what the payer owes, negative reduces it.
    amountKobo: {
      type: Number,
      required: true,
      validate: { validator: (v) => Number.isSafeInteger(v) && v !== 0, message: 'amountKobo must be a non-zero integer' },
    },
    balanceAfterKobo: { type: Number, required: true },
    description: { type: String, maxlength: 300 },
    refType: String, // 'charge' | 'payment' | 'invoice' | 'adjustment'
    refId: Schema.Types.ObjectId,
    encounterId: Schema.Types.ObjectId,
    invoiceId: Schema.Types.ObjectId,
    idempotencyKey: { type: String, required: true },
    reversalOf: { type: Schema.Types.ObjectId, ref: 'LedgerEntry' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

ledgerEntrySchema.index({ payerId: 1, seq: 1 }, { unique: true });
ledgerEntrySchema.index({ idempotencyKey: 1 }, { unique: true });
ledgerEntrySchema.index({ reversalOf: 1 }, { unique: true, partialFilterExpression: { reversalOf: { $type: 'objectId' } } });
ledgerEntrySchema.index({ refType: 1, refId: 1 });

appendOnly(ledgerEntrySchema, 'LedgerEntry');
export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
