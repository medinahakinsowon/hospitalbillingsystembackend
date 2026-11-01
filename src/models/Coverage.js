import mongoose from 'mongoose';
const { Schema } = mongoose;

const coverageSchema = new Schema(
  {
    payerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    relationship: { type: String, enum: ['self', 'employee', 'dependant', 'holder', 'member'], required: true },
    employeeRef: String, // staff number at the company
    memberLimitKobo: {
      type: Number,
      default: null,
      validate: { validator: (v) => v === null || Number.isSafeInteger(v), message: 'must be an integer number of kobo' },
    },
    usageVersion: { type: Number, default: 0 }, // bumped when a limited member is charged, to serialise concurrent charges
    validFrom: { type: Date, required: true, default: Date.now },
    validTo: { type: Date, default: null },
    status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

coverageSchema.index({ payerId: 1, status: 1 });
coverageSchema.index({ patientId: 1, status: 1 });
// A patient can only have one active coverage per payer.
coverageSchema.index({ payerId: 1, patientId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

export const Coverage = mongoose.model('Coverage', coverageSchema);
