import mongoose from 'mongoose';
const { Schema } = mongoose;

const koboField = (extra = {}) => ({ type: Number, min: 0, validate: { validator: Number.isSafeInteger, message: 'must be an integer number of kobo' }, ...extra });

// A payer's pre-approval for an expensive service. Approving records the payer's own reference (e.g. the company's approval code).
const authorizationSchema = new Schema(
  {
    authNo: { type: String, required: true },
    payerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', default: null }, // null = any service
    encounterId: { type: Schema.Types.ObjectId, ref: 'Encounter', default: null }, // null = any visit
    description: { type: String, maxlength: 200 }, // billing note only, no clinical detail
    requestedAmountKobo: koboField({ required: true }),
    approvedAmountKobo: koboField({ default: 0 }),
    usedKobo: koboField({ default: 0 }),
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    expiresAt: Date,
    externalRef: { type: String, maxlength: 80 }, // the payer's approval reference
    decisionNote: { type: String, maxlength: 300 },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
  },
  { timestamps: true }
);
authorizationSchema.index({ authNo: 1 }, { unique: true });
authorizationSchema.index({ payerId: 1, patientId: 1, status: 1, expiresAt: 1 });
authorizationSchema.index({ status: 1, createdAt: -1 });

export const Authorization = mongoose.model('Authorization', authorizationSchema);
