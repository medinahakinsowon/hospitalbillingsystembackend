import mongoose from 'mongoose';
const { Schema } = mongoose;

export const DEPARTMENTS = ['consultation', 'laboratory', 'pharmacy', 'radiology', 'procedure', 'ward', 'other'];

const serviceSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    department: { type: String, enum: DEPARTMENTS, required: true },
    category: { type: String, lowercase: true, trim: true, maxlength: 60 },
    active: { type: Boolean, default: true },
    requiresAuthorization: { type: Boolean, default: false }, // e.g. MRI: payers must pre-approve it
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
serviceSchema.index({ code: 1 }, { unique: true });
serviceSchema.index({ department: 1, active: 1 });
serviceSchema.index({ name: 1 });

export const Service = mongoose.model('Service', serviceSchema);
