import mongoose from 'mongoose';
const { Schema } = mongoose;

// Outbox of SMS and emails. Business events insert rows (in the same transaction as the event);
// a dispatcher sends them with retries. Messages carry amounts and document numbers only, never clinical detail.
const notificationSchema = new Schema(
  {
    channel: { type: String, enum: ['email', 'sms'], required: true },
    to: { type: String, required: true, maxlength: 200 },
    subject: { type: String, maxlength: 200 },
    body: { type: String, required: true, maxlength: 1000 },
    template: { type: String, required: true },
    payerId: { type: Schema.Types.ObjectId, ref: 'Payer' },
    relatedType: String, // 'payment' | 'invoice' | 'payer'
    relatedId: Schema.Types.ObjectId,
    dedupeKey: { type: String, required: true }, // the same event can never be queued twice
    status: { type: String, enum: ['queued', 'sending', 'sent', 'failed'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    sendAfter: { type: Date, default: Date.now },
    claimedAt: Date,
    sentAt: Date,
    providerId: String,
    lastError: { type: String, maxlength: 300 },
  },
  { timestamps: true }
);
notificationSchema.index({ dedupeKey: 1 }, { unique: true });
notificationSchema.index({ status: 1, sendAfter: 1 });
notificationSchema.index({ relatedType: 1, relatedId: 1 });
notificationSchema.index({ payerId: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
