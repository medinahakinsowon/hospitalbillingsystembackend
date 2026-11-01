import mongoose from 'mongoose';
const { Schema } = mongoose;

const kobo = { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'must be an integer number of kobo' } };

const lineSchema = new Schema(
  {
    chargeId: { type: Schema.Types.ObjectId, ref: 'Charge', required: true },
    date: Date,
    description: String,
    department: String,
    // Present on consolidated invoices and statements so each person's treatments can be listed separately
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient' },
    patientName: String,
    hospitalNumber: String,
    employeeRef: String,
    encounterNo: String,
    credited: { type: Boolean, default: false }, // this line was credited by a credit note
    qty: Number,
    unitPriceKobo: kobo,
    totalKobo: kobo,
  },
  { _id: false }
);

const invoiceSchema = new Schema(
  {
    invoiceNo: { type: String, required: true },
    type: { type: String, enum: ['visit', 'consolidated', 'statement'], default: 'visit' },
    status: { type: String, enum: ['issued', 'partial', 'paid', 'void'], default: 'issued' },

    payerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    payerType: String,
    payerCode: String,
    payerName: String,
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient' },
    patientName: String,
    hospitalNumber: String,
    encounterId: { type: Schema.Types.ObjectId, ref: 'Encounter' },
    encounterNo: String,

    lines: [lineSchema],
    totalKobo: kobo,
    // paidKobo counts everything that settles the invoice: payments AND credits. creditedKobo is the credit part.
    paidKobo: { ...kobo, default: 0 },
    creditedKobo: { ...kobo, default: 0 },

    periodStart: Date, // consolidated invoices and statements
    periodEnd: Date,
    issuedAt: { type: Date, default: Date.now },
    dueAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
invoiceSchema.index({ invoiceNo: 1 }, { unique: true });
invoiceSchema.index({ payerId: 1, status: 1, dueAt: 1 });
invoiceSchema.index({ encounterId: 1, payerId: 1 });
invoiceSchema.index({ patientId: 1, issuedAt: -1 });
invoiceSchema.index({ payerId: 1, type: 1, periodEnd: -1 });

export const Invoice = mongoose.model('Invoice', invoiceSchema);
