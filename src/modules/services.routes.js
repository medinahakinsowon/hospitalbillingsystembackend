import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, pagination } from '../utils/schemas.js';
import { DEPARTMENTS } from '../models/Service.js';
import { reqContext } from '../services/audit.service.js';
import * as catalog from '../services/catalog.service.js';

const router = Router();
router.use(authenticate());

const fields = {
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, . _ - only'),
  name: z.string().trim().min(2).max(160),
  department: z.enum(DEPARTMENTS),
  category: z.string().trim().max(60).optional(),
};

router.post('/', requirePermission('services:manage'), validate({ body: z.object(fields) }),
  asyncHandler(async (req, res) => res.status(201).json(await catalog.createService(req.body, reqContext(req)))));

router.get('/', requirePermission('services:read'),
  validate({ query: pagination.extend({
    q: z.string().trim().min(1).max(80).optional(),
    department: z.enum(DEPARTMENTS).optional(),
    active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await catalog.listServices(req.query))));

router.patch('/:id', requirePermission('services:manage'),
  validate({ params: idParam, body: z.object({ name: fields.name, department: fields.department, category: fields.category, active: z.boolean() })
    .partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update') }),
  asyncHandler(async (req, res) => res.json(await catalog.updateService(req.params.id, req.body, reqContext(req)))));

export default router;
