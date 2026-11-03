import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ROLE_PERMISSIONS } from '../config/permissions.js';
import { User } from '../models/User.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { password } from '../utils/schemas.js';
import { recordAudit, reqContext } from '../services/audit.service.js';
import * as mfa from '../services/mfa.service.js';

const router = Router();
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10); // so unknown emails take as long as real ones

// NOTE: this limiter is per serverless instance on Vercel. Add Vercel Firewall / a shared store later.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

const signToken = (user) =>
  jwt.sign({ sub: String(user._id), role: user.role, tv: user.tokenVersion }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_EXPIRES_IN,
  });

router.post(
  '/login',
  loginLimiter,
  validate({ body: z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1).max(128) }) }),
  asyncHandler(async (req, res) => {
    const { email, password: pw } = req.body;
    const ctx = reqContext(req);
    const user = await User.findOne({ email }).select('+passwordHash');

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await recordAudit(ctx, { action: 'auth.login.locked', entity: 'User', entityId: user._id });
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }

    const ok = await bcrypt.compare(pw, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.status !== 'active') {
      if (user) {
        const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { failedLoginAttempts: 1 } }, { returnDocument: 'after' });
        if (updated.failedLoginAttempts >= MAX_ATTEMPTS) {
          await User.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000), failedLoginAttempts: 0 } });
        }
      }
      await recordAudit({ ...ctx, actorId: user?._id ?? null }, { action: 'auth.login.failed', entity: 'User', entityId: user?._id, meta: { email } });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (user.mfaEnabled) {
      // Password was right; now they must also give a code. Nothing is granted yet except a 5-minute pass to the next step.
      const mfaToken = jwt.sign({ sub: String(user._id), purpose: 'mfa' }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
      return res.json({ mfaRequired: true, mfaToken });
    }
    await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await recordAudit({ ...ctx, actorId: user._id, actorRole: user.role }, { action: 'auth.login', entity: 'User', entityId: user._id });
    res.json({ token: signToken(user), user: user.toJSON(), mustChangePassword: user.mustChangePassword });
  })
);

router.get(
  '/me',
  authenticate({ allowPasswordChange: true, allowMfaSetup: true }),
  (req, res) => res.json({ user: req.user, permissions: ROLE_PERMISSIONS[req.user.role] })
);

router.post(
  '/change-password',
  authenticate({ allowPasswordChange: true, allowMfaSetup: true }),
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: password }) }),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id).select('+passwordHash');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    if (currentPassword === newPassword) throw new AppError(400, 'PASSWORD_REUSED', 'Choose a different password');

    user.passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
    user.mustChangePassword = false;
    user.tokenVersion += 1; // signs out every other session
    await user.save();
    await recordAudit(reqContext(req), { action: 'auth.password.change', entity: 'User', entityId: user._id });
    res.json({ token: signToken(user) });
  })
);

// ---------------------------------------------------------------- two-factor authentication
const setupAuth = authenticate({ allowMfaSetup: true });
const codeField = z.string().trim().regex(/^\d{6}$/, 'enter the 6-digit code from your authenticator app');

router.post('/mfa/setup', setupAuth, asyncHandler(async (req, res) => res.json(await mfa.beginSetup(req.user.id, reqContext(req)))));

router.post('/mfa/confirm', setupAuth, validate({ body: z.object({ code: codeField }) }),
  asyncHandler(async (req, res) => {
    const { user, backupCodes } = await mfa.confirmSetup(req.user.id, req.body.code, reqContext(req));
    res.json({ token: signToken(user), backupCodes }); // other sessions were signed out; this fresh token continues
  }));

// Second step of login for accounts with MFA on
router.post('/mfa/verify', loginLimiter,
  validate({ body: z.object({ mfaToken: z.string().min(20), code: codeField.optional(), backupCode: z.string().trim().min(6).max(20).optional() })
    .refine((b) => Boolean(b.code) !== Boolean(b.backupCode), 'Give either code or backupCode') }),
  asyncHandler(async (req, res) => {
    let payload;
    try { payload = jwt.verify(req.body.mfaToken, env.JWT_SECRET, { algorithms: ['HS256'] }); } catch { throw new AppError(401, 'INVALID_TOKEN', 'Your sign-in expired. Start again.'); }
    if (payload.purpose !== 'mfa') throw new AppError(401, 'INVALID_TOKEN', 'Your sign-in expired. Start again.');

    const user = await User.findById(payload.sub).select('+mfaSecretEnc +mfaLastStep');
    if (!user || user.status !== 'active' || !user.mfaEnabled) throw new AppError(401, 'INVALID_TOKEN', 'Your sign-in expired. Start again.');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');

    const ctx = reqContext(req);
    if (!(await mfa.verifySecondFactor(user, req.body))) {
      const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { failedLoginAttempts: 1 } }, { returnDocument: 'after' });
      if (updated.failedLoginAttempts >= MAX_ATTEMPTS) await User.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000), failedLoginAttempts: 0 } });
      await recordAudit({ ...ctx, actorId: user._id }, { action: 'auth.mfa.failed', entity: 'User', entityId: user._id });
      throw new AppError(401, 'INVALID_CODE', 'That code is not correct');
    }
    await User.updateOne({ _id: user._id }, { $set: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await recordAudit({ ...ctx, actorId: user._id, actorRole: user.role }, { action: 'auth.login', entity: 'User', entityId: user._id, meta: { mfa: req.body.backupCode ? 'backup_code' : 'totp' } });
    res.json({ token: signToken(user), user: user.toJSON(), mustChangePassword: user.mustChangePassword });
  }));

router.post('/mfa/disable', authenticate(), validate({ body: z.object({ password: z.string().min(1).max(128), code: codeField }) }),
  asyncHandler(async (req, res) => { await mfa.disableMfa(req.user.id, req.body, reqContext(req)); res.json({ disabled: true }); }));

export default router;
