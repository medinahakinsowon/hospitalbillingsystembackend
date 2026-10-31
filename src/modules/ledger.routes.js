import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import { reverseLedgerEntry } from '../services/ledger.service.js';

const router = Router();
router.use(authenticate());

// Corrections are made by posting an opposite entry, never by editing history.
router.post(
  '/entries/:id/reverse',
  requirePermission('ledger:reverse'),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5).max(200) }) }),
  asyncHandler(async (req, res) =>
    res.status(201).json(await reverseLedgerEntry({ entryId: req.params.id, reason: req.body.reason }, reqContext(req))))
);

export default router;
