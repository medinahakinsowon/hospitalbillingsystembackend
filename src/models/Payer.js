import mongoose from 'mongoose';
const { Schema } = mongoose;

const kobo = (extra = {}) => ({
  type: Number,
  default: 0,
  validate: { validator: Number.isSafeInteger, message: '{PATH} must be an integer number of kobo' },
  ...extra,
});

const payerSchema = new Schema(
  {
    type: { type: String, enum: ['corporate', 'family', 'individual'], required: true },
    code: { type: String, required: true }, // e.g. COR-000001, FAM-000001, IND-000001
    name: { type: String, required: true, trim: true, maxlength: 160 },
    status: { type: String, enum: ['active', 'suspended', 'closed'], default: 'active' },
    tariffId: { type: Schema.Types.ObjectId, ref: 'Tariff', default: null }, // Phase 2

    billingContact: { name: String, email: String, phone: String },

    // Convention: balanceKobo = amount the payer owes the hospital. Negative = deposit held.
    // available = creditLimitKobo - balanceKobo (only when enforceLimit is true).
    creditLimitKobo: kobo({ min: 0 }),
    balanceKobo: kobo(), // cached; the ledger is the source of truth
    ledgerSeq: { type: Number, default: 0 },
    // Corporate and family cards enforce limits. Individual (walk-in) payers do not:
    // payment for them is enforced by the visit workflow (pay before service / before discharge).
    enforceLimit: { type: Boolean, default: true },

    mode: { type: String, enum: ['credit', 'prepaid'] }, // family cards only; default credit
    paymentTermsDays: { type: Number, min: 0, max: 365 },
    billingCycle: { type: String, enum: ['weekly', 'monthly', 'quarterly'] },
    holderPatientId: { type: Schema.Types.ObjectId, ref: 'Patient' }, // family: card holder; individual: the patient
    guarantor: { name: String, phone: String, idRef: String },
    contract: {
      startsAt: Date,
      endsAt: Date,
      coveredServices: [String],
      excludedServices: [String],
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

payerSchema.index({ code: 1 }, { unique: true });
payerSchema.index({ type: 1, status: 1 });
payerSchema.index({ holderPatientId: 1 });
payerSchema.index({ name: 1 });

export const Payer = mongoose.model('Payer', payerSchema);
