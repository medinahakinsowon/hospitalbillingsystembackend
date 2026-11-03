import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ROLES } from '../config/permissions.js';
import { User } from '../models/User.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, pagination, password } from '../utils/schemas.js';
import { recordAudit, reqContext } from '../services/audit.service.js';
import { adminResetMfa } from '../services/mfa.service.js';

const router = Router();
router.use(authenticate(), requirePermission('users:manage'));

router.post(
  '/',
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().email().toLowerCase(),
      role: z.enum(ROLES),
      temporaryPassword: password,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { temporaryPassword, ...rest } = req.body;
    const user = await User.create({
      ...rest,
      passwordHash: await bcrypt.hash(temporaryPassword, env.BCRYPT_ROUNDS),
      mustChangePassword: true,
    });
    await recordAudit(reqContext(req), { action: 'user.create', entity: 'User', entityId: user._id, after: { email: user.email, role: user.role } });
    res.status(201).json(user.toJSON());
  })
);

router.get(
  '/',
  validate({ query: pagination }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const [items, total] = await Promise.all([
      User.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      User.countDocuments(),
    ]);
    res.json({ items: items.map((u) => u.toJSON()), page, limit, total });
  })
);

router.patch(
  '/:id',
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      role: z.enum(ROLES).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      resetPassword: password.optional(), // sets a new temporary password
    }).refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (String(user._id) === String(req.user.id) && (req.body.status === 'disabled' || (req.body.role && req.body.role !== user.role))) {
      throw new AppError(422, 'NOT_ALLOWED', 'You cannot disable or change the role of your own account');
    }

    const before = { name: user.name, role: user.role, status: user.status };
    const { resetPassword, ...fields } = req.body;
    user.set(fields);
    const security = fields.role !== undefined || fields.status !== undefined || resetPassword;
    if (resetPassword) {
      user.passwordHash = await bcrypt.hash(resetPassword, env.BCRYPT_ROUNDS);
      user.mustChangePassword = true;
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
    }
    if (security) user.tokenVersion += 1; // revoke existing sessions immediately
    await user.save();

    await recordAudit(reqContext(req), {
      action: 'user.update', entity: 'User', entityId: user._id, before,
      after: { name: user.name, role: user.role, status: user.status }, meta: { passwordReset: Boolean(resetPassword) },
    });
    res.json(user.toJSON());
  })
);

// Lost phone? Clear their two-factor setup; they enrol again at next sign-in.
router.post('/:id/mfa-reset', validate({ params: idParam }),
  asyncHandler(async (req, res) => { await adminResetMfa(req.params.id, reqContext(req)); res.json({ reset: true }); }));

export default router;
