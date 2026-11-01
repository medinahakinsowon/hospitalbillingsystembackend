import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, kobo, objectId, pagination } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import * as adj from '../services/adjustments.service.js';

const router = Router();
router.use(authenticate());
const reason = z.string().trim().min(5).max(200);
const note = z.string().trim().max(300).optional();

const requestBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discount'), invoiceId: objectId, amountKobo: kobo.min(1).optional(), percent: z.number().int().min(1).max(100).optional(), reason }),
  z.object({ kind: z.literal('waiver'), invoiceId: objectId, reason }),
  z.object({ kind: z.literal('writeoff'), invoiceId: objectId, amountKobo: kobo.min(1).optional(), reason }),
  z.object({ kind: z.literal('credit_note'), invoiceId: objectId, chargeIds: z.array(objectId).min(1).max(200), reason }),
]).refine((b) => b.kind !== 'discount' || Boolean(b.amountKobo) !== Boolean(b.percent), { message: 'Give either amountKobo or percent for a discount, not both', path: ['amountKobo'] });

// Requesting changes nothing; a different person must approve.
router.post('/', requirePermission('adjustments:request'), validate({ body: requestBody }),
  asyncHandler(async (req, res) => res.status(201).json(await adj.requestAdjustment(req.body, reqContext(req)))));

router.get('/', requirePermission('adjustments:read'),
  validate({ query: pagination.extend({
    invoiceId: objectId.optional(), payerId: objectId.optional(),
    status: z.enum(['pending', 'applied', 'rejected', 'cancelled']).optional(),
    kind: z.enum(['discount', 'waiver', 'credit_note', 'writeoff']).optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await adj.listAdjustments(req.query))));

router.get('/:id', requirePermission('adjustments:read'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await adj.getAdjustment(req.params.id))));

router.post('/:id/approve', requirePermission('adjustments:approve'), validate({ params: idParam, body: z.object({ note }) }),
  asyncHandler(async (req, res) => res.json(await adj.decideAdjustment(req.params.id, { decision: 'approve', note: req.body.note }, reqContext(req)))));

router.post('/:id/reject', requirePermission('adjustments:approve'), validate({ params: idParam, body: z.object({ note }) }),
  asyncHandler(async (req, res) => res.json(await adj.decideAdjustment(req.params.id, { decision: 'reject', note: req.body.note }, reqContext(req)))));

router.post('/:id/cancel', requirePermission('adjustments:request'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await adj.cancelAdjustment(req.params.id, reqContext(req)))));

export default router;
