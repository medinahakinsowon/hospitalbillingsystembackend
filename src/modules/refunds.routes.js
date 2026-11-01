import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, kobo, objectId, pagination } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import * as refunds from '../services/refunds.service.js';

const router = Router();
router.use(authenticate());
const note = z.string().trim().max(300).optional();

router.post('/', requirePermission('refunds:request'),
  validate({ body: z.object({
    paymentId: objectId, amountKobo: kobo.min(1), method: z.enum(['cash', 'transfer']), reason: z.string().trim().min(5).max(200),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json(await refunds.requestRefund(req.body, reqContext(req)))));

router.get('/', requirePermission('refunds:read'),
  validate({ query: pagination.extend({
    payerId: objectId.optional(), paymentId: objectId.optional(),
    status: z.enum(['pending', 'approved', 'paid', 'rejected', 'cancelled']).optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await refunds.listRefunds(req.query))));

router.get('/:id', requirePermission('refunds:read'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await refunds.getRefund(req.params.id))));

router.post('/:id/approve', requirePermission('refunds:approve'), validate({ params: idParam, body: z.object({ note }) }),
  asyncHandler(async (req, res) => res.json(await refunds.decideRefund(req.params.id, { decision: 'approve', note: req.body.note }, reqContext(req)))));

router.post('/:id/reject', requirePermission('refunds:approve'), validate({ params: idParam, body: z.object({ note }) }),
  asyncHandler(async (req, res) => res.json(await refunds.decideRefund(req.params.id, { decision: 'reject', note: req.body.note }, reqContext(req)))));

router.post('/:id/pay', requirePermission('refunds:pay'),
  validate({ params: idParam, body: z.object({ payoutRef: z.string().trim().min(3).max(80) }) }),
  asyncHandler(async (req, res) => res.json(await refunds.payRefund(req.params.id, req.body, reqContext(req)))));

router.post('/:id/cancel', requirePermission('refunds:request'),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5).max(200) }) }),
  asyncHandler(async (req, res) => res.json(await refunds.cancelRefund(req.params.id, req.body.reason, reqContext(req)))));

export default router;
