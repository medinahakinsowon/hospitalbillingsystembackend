import mongoose from 'mongoose';
const { Schema } = mongoose;

const patientSchema = new Schema(
  {
    hospitalNumber: { type: String, required: true },
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    otherNames: { type: String, trim: true, maxlength: 80 },
    dob: { type: Date, required: true },
    sex: { type: String, enum: ['male', 'female'], required: true },
    phone: { type: String, required: true },
    email: { type: String, lowercase: true, trim: true },
    address: { line: String, city: String, state: String },
    nextOfKin: { name: String, phone: String, relationship: String },
    photoUrl: String,
    searchName: { type: String }, // lowercase "last first other" for search and duplicate checks
    selfPayerId: { type: Schema.Types.ObjectId, ref: 'Payer' },
    status: { type: String, enum: ['active', 'inactive', 'deceased'], default: 'active' },
    deletedAt: { type: Date, default: null }, // soft delete only
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

patientSchema.index({ hospitalNumber: 1 }, { unique: true });
patientSchema.index({ phone: 1 });
patientSchema.index({ searchName: 1 });
patientSchema.index({ dob: 1, searchName: 1 });

patientSchema.pre('validate', function () {
  this.searchName = [this.lastName, this.firstName, this.otherNames].filter(Boolean).join(' ').toLowerCase();
});

export const Patient = mongoose.model('Patient', patientSchema);
