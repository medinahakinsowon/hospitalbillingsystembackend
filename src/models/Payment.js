import mongoose from 'mongoose';
const { Schema } = mongoose;

const paymentSchema = new Schema(
  {
    receiptNo: String, // assigned only when the payment succeeds (gap-free)
    payerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient' },
    encounterId: { type: Schema.Types.ObjectId, ref: 'Encounter' },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    method: { type: String, enum: ['cash', 'pos', 'transfer', 'paystack'], required: true },
    amountKobo: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: 'amountKobo must be an integer number of kobo' },
    },
    // Part of the payment not yet applied to an invoice (a deposit or top-up). Applied automatically to later invoices.
    unallocatedKobo: { type: Number, default: 0, min: 0 },
    allocations: [{ _id: false, invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' }, amountKobo: Number }],
    // 'flagged' = the gateway reported success but something did not match (e.g. amount); needs a human.
    status: { type: String, enum: ['pending', 'success', 'failed', 'abandoned', 'flagged'], default: 'pending' },
    externalRef: { type: String, maxlength: 80 }, // POS slip no. or bank transfer reference
    paystack: {
      reference: String,
      accessCode: String,
      authorizationUrl: String,
      transactionId: Number,
      channel: String,
      paidAt: Date,
      gatewayResponse: String,
      fees: Number,
      note: String,
    },
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: 'LedgerEntry' },
    idempotencyKey: String,
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completedAt: Date,
  },
  { timestamps: true }
);
paymentSchema.index({ 'paystack.reference': 1 }, { unique: true, partialFilterExpression: { 'paystack.reference': { $type: 'string' } } });
paymentSchema.index({ receiptNo: 1 }, { unique: true, partialFilterExpression: { receiptNo: { $type: 'string' } } });
paymentSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
paymentSchema.index({ payerId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ payerId: 1, status: 1, unallocatedKobo: 1 });
paymentSchema.index({ status: 1, method: 1, createdAt: 1 });

export const Payment = mongoose.model('Payment', paymentSchema);
