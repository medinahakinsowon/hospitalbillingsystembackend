import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { dateOnly, idParam, kobo } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import { updateCoverage } from '../services/coverage.service.js';

const router = Router();
router.use(authenticate(), requirePermission('coverages:manage'));

router.patch(
  '/:id',
  validate({
    params: idParam,
    body: z.object({
      status: z.enum(['active', 'inactive', 'suspended']),
      validTo: dateOnly.nullable(),
      memberLimitKobo: kobo.min(0).nullable(),
      employeeRef: z.string().max(60),
    }).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => res.json(await updateCoverage(req.params.id, req.body, reqContext(req))))
);

export default router;
