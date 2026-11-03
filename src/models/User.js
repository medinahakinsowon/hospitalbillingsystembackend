import mongoose from 'mongoose';
import { ROLES } from '../config/permissions.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    mustChangePassword: { type: Boolean, default: true },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
    mfaEnabled: { type: Boolean, default: false },
    mfaEnrolledAt: Date,
    // The authenticator secret is encrypted at rest; backup codes are stored only as hashes.
    mfaSecretEnc: { type: String, select: false },
    mfaBackupCodes: { type: [String], select: false },
    mfaLastStep: { type: Number, default: 0, select: false }, // last accepted 30-second step: a code can never be used twice
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash;
        delete ret.mfaSecretEnc;
        delete ret.mfaBackupCodes;
        delete ret.mfaLastStep;
        delete ret.__v;
        return ret;
      },
    },
  }
);
userSchema.index({ email: 1 }, { unique: true });

export const User = mongoose.model('User', userSchema);
