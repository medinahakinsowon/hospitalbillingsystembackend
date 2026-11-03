import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';
import { decryptSecret, encryptSecret } from '../utils/secretBox.js';
import { generateSecret, otpauthUri, verifyTotp } from '../utils/totp.js';
import { recordAudit } from './audit.service.js';

export const requiresMfa = (role) => env.MFA_REQUIRED_ROLES.includes(role);

const normalise = (code) => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code) => crypto.createHash('sha256').update(normalise(code)).digest('hex'); // codes are random, so a plain hash is enough
function newBackupCodes(count = 10) {
  return Array.from({ length: count }, () => { const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); return `${raw.slice(0, 5)}-${raw.slice(5)}`; });
}

/** Step 1 of enrolment: make a secret. The user adds it to an authenticator app (scan the otpauth link as a QR code). */
export async function beginSetup(userId, ctx) {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  if (user.mfaEnabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already on for this account');
  const secret = generateSecret();
  user.mfaSecretEnc = encryptSecret(secret); // stored encrypted; shown to the user only now
  await user.save();
  await recordAudit(ctx, { action: 'mfa.setup.begin', entity: 'User', entityId: user._id });
  return { secret, otpauthUri: otpauthUri({ secret, account: user.email, issuer: env.HOSPITAL_NAME }) };
}

/** Step 2: prove the app works by entering a current code. Returns one-time backup codes, shown only once. */
export async function confirmSetup(userId, code, ctx) {
  const user = await User.findById(userId).select('+mfaSecretEnc');
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  if (user.mfaEnabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already on for this account');
  if (!user.mfaSecretEnc) throw new AppError(422, 'NO_SETUP_IN_PROGRESS', 'Start setup first');
  const step = verifyTotp(decryptSecret(user.mfaSecretEnc), code);
  if (!step) throw new AppError(400, 'INVALID_CODE', 'That code is not correct. Check your phone\'s clock and try again.');
  const backupCodes = newBackupCodes();
  user.set({ mfaEnabled: true, mfaEnrolledAt: new Date(), mfaLastStep: step, mfaBackupCodes: backupCodes.map(hashCode) });
  user.tokenVersion += 1; // signs out other sessions
  await user.save();
  await recordAudit(ctx, { action: 'mfa.enable', entity: 'User', entityId: user._id });
  return { user, backupCodes };
}

/** Check a second factor at login. A code works once only; each backup code works once only. */
export async function verifySecondFactor(user, { code, backupCode }) {
  if (code) {
    const step = verifyTotp(decryptSecret(user.mfaSecretEnc), code, { lastStep: user.mfaLastStep ?? 0 });
    if (!step) return false;
    const r = await User.updateOne({ _id: user._id, mfaLastStep: { $lt: step } }, { $set: { mfaLastStep: step } }); // atomic: blocks replay across servers
    return r.modifiedCount === 1;
  }
  if (backupCode) {
    const h = hashCode(backupCode);
    const r = await User.updateOne({ _id: user._id, mfaBackupCodes: h }, { $pull: { mfaBackupCodes: h } });
    return r.modifiedCount === 1;
  }
  return false;
}

const clearFields = { $set: { mfaEnabled: false, mfaLastStep: 0 }, $unset: { mfaSecretEnc: 1, mfaEnrolledAt: 1 }, $inc: { tokenVersion: 1 } };

/** Turn MFA off yourself (not allowed for roles that must have it). Needs your password and a current code. */
export async function disableMfa(userId, { password, code }, ctx) {
  const user = await User.findById(userId).select('+passwordHash +mfaSecretEnc +mfaLastStep');
  if (!user?.mfaEnabled) throw new AppError(400, 'MFA_NOT_ENABLED', 'Two-factor authentication is not on for this account');
  if (requiresMfa(user.role)) throw new AppError(403, 'MFA_REQUIRED_FOR_ROLE', 'Your role must use two-factor authentication. Ask an administrator.');
  if (!(await bcrypt.compare(password, user.passwordHash)) || !(await verifySecondFactor(user, { code }))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Password or code is incorrect');
  }
  await User.updateOne({ _id: user._id }, { ...clearFields, $set: { ...clearFields.$set, mfaBackupCodes: [] } });
  await recordAudit(ctx, { action: 'mfa.disable', entity: 'User', entityId: user._id });
}

/** An administrator clears someone's MFA (lost phone). The person must enrol again at next login. */
export async function adminResetMfa(targetId, ctx) {
  const r = await User.updateOne({ _id: targetId }, { ...clearFields, $set: { ...clearFields.$set, mfaBackupCodes: [] } });
  if (!r.matchedCount) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  await recordAudit(ctx, { action: 'mfa.reset', entity: 'User', entityId: targetId });
}
