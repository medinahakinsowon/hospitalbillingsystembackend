import mongoose from 'mongoose';
const { Schema } = mongoose;

const koboField = { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'must be an integer number of kobo' } };

const chargeSchema = new Schema(
  {
    encounterId: { type: Schema.Types.ObjectId, ref: 'Encounter', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    payerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
    // Snapshots: later catalog or price changes never rewrite what was billed.
    serviceCode: { type: String, required: true },
    description: { type: String, required: true, maxlength: 200 },
    department: String,
    qty: { type: Number, required: true, min: 1, max: 1000, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
    unitPriceKobo: koboField,
    totalKobo: koboField,
    tariffId: { type: Schema.Types.ObjectId, ref: 'Tariff' },
    tariffItemId: { type: Schema.Types.ObjectId, ref: 'TariffItem' },
    priceSource: { type: String, enum: ['payer_tariff', 'default_tariff'] },

    ledgerEntryId: { type: Schema.Types.ObjectId, ref: 'LedgerEntry' },
    status: { type: String, enum: ['posted', 'reversed'], default: 'posted' },
    reversalReason: String,
    reversedAt: Date,
    reversedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    replacedBy: { type: Schema.Types.ObjectId, ref: 'Charge' }, // set when a payer reassignment re-posts this charge
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },

    idempotencyKey: String,
    overrideReason: String,
    capturedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    capturedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
chargeSchema.index({ encounterId: 1, status: 1 });
chargeSchema.index({ payerId: 1, status: 1, invoiceId: 1 });
chargeSchema.index({ patientId: 1, capturedAt: -1 });
chargeSchema.index({ invoiceId: 1 });
chargeSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

export const Charge = mongoose.model('Charge', chargeSchema);
