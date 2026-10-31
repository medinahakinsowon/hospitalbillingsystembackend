import { Router } from 'express';
import { z } from 'zod';
import { AuditLog } from '../models/AuditLog.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { objectId, pagination } from '../utils/schemas.js';

const router = Router();
router.use(authenticate(), requirePermission('audit:read'));

router.get(
  '/',
  validate({
    query: pagination.extend({
      entity: z.string().max(40).optional(),
      entityId: objectId.optional(),
      actorId: objectId.optional(),
      action: z.string().max(60).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit, from, to, ...rest } = req.query;
    const filter = { ...rest };
    if (from || to) filter.at = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    const [items, total] = await Promise.all([
      AuditLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ items, page, limit, total });
  })
);

export default router;
