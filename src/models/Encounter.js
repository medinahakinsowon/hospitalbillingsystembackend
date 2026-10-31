import mongoose from 'mongoose';
const { Schema } = mongoose;

// Billing view of a visit. Deliberately holds no clinical data.
const encounterSchema = new Schema(
  {
    encounterNo: { type: String, required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    type: { type: String, enum: ['outpatient', 'inpatient', 'emergency'], required: true },
    status: { type: String, enum: ['open', 'closed', 'cancelled'], default: 'open' },
    primaryPayerId: { type: Schema.Types.ObjectId, ref: 'Payer', required: true },
    department: { type: String, maxlength: 60 },
    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
    openedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    closeOverride: { reason: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, unpaidKobo: Number },
    cancelReason: String,
  },
  { timestamps: true }
);
encounterSchema.index({ encounterNo: 1 }, { unique: true });
encounterSchema.index({ patientId: 1, status: 1 });
encounterSchema.index({ status: 1, openedAt: -1 });
encounterSchema.index({ primaryPayerId: 1, status: 1 });

export const Encounter = mongoose.model('Encounter', encounterSchema);
