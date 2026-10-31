import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import { voidCharge } from '../services/charges.service.js';

const router = Router();
router.use(authenticate());

router.post('/:id/void', requirePermission('charges:void'),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5).max(200) }) }),
  asyncHandler(async (req, res) => res.json(await voidCharge(req.params.id, req.body.reason, reqContext(req)))));

export default router;
