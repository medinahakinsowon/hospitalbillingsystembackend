import mongoose from 'mongoose';
const { Schema } = mongoose;

// Webhook log used for idempotency and troubleshooting. Stores a minimal, non-sensitive summary only.
const paystackEventSchema = new Schema(
  {
    eventType: { type: String, required: true },
    reference: { type: String, required: true },
    status: { type: String, enum: ['received', 'processed', 'failed', 'ignored'], default: 'received' },
    outcome: String,
    summary: { amount: Number, currency: String, channel: String, gatewayStatus: String },
    attempts: { type: Number, default: 0 },
    error: String,
    receivedAt: { type: Date, default: Date.now },
    processedAt: Date,
  },
  { versionKey: false }
);
paystackEventSchema.index({ eventType: 1, reference: 1 }, { unique: true });
paystackEventSchema.index({ status: 1, receivedAt: -1 });

export const PaystackEvent = mongoose.model('PaystackEvent', paystackEventSchema);
